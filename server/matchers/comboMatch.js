const { daysBetween } = require('../utils/csvParser');

const COMBO_DATE_WINDOW_DAYS = 5;
const AMOUNT_TOLERANCE = 0.02; // absolute currency-unit tolerance for float rounding

/**
 * STAGE 3 — SPLIT / COMBO MATCH
 * Checks whether 2-3 rows on one side sum to a single row on the other side
 * (the common case: one bank deposit = several invoice payments bundled
 * together, or occasionally the reverse — one invoice paid in installments).
 *
 * Confidence 0.6-0.9, scaled down as more rows are combined (more rows =
 * more room for a coincidental sum) and by how tight the date clustering is.
 */
function comboMatchStage(bankRows, ledgerRows) {
  const matches = [];
  const matchedBankIds = new Set();
  const matchedLedgerIds = new Set();

  // Direction A: one bank row = sum of 2-3 ledger rows
  matchOneToMany(bankRows, ledgerRows, matchedBankIds, matchedLedgerIds, matches, 'bank_one_ledger_many');

  // Direction B: one ledger row = sum of 2-3 bank rows
  matchOneToMany(ledgerRows, bankRows, matchedLedgerIds, matchedBankIds, matches, 'ledger_one_bank_many', true);

  const unmatchedBank = bankRows.filter((r) => !matchedBankIds.has(r._id));
  const unmatchedLedger = ledgerRows.filter((r) => !matchedLedgerIds.has(r._id));

  return { matches, unmatchedBank, unmatchedLedger };
}

/**
 * For each row in `oneSide`, look for 2-3 rows in `manySide` (within the date
 * window, not yet matched) whose amounts sum to the one row's amount.
 * `reversed` flips which side is treated as "bank_ref" vs "ledger_ref" in output.
 */
function matchOneToMany(oneSide, manySide, oneMatchedIds, manyMatchedIds, matches, tag, reversed = false) {
  for (const oneRow of oneSide) {
    if (oneMatchedIds.has(oneRow._id)) continue;

    const candidates = manySide.filter(
      (r) => !manyMatchedIds.has(r._id) && daysBetween(r.date, oneRow.date) <= COMBO_DATE_WINDOW_DAYS
    );
    if (candidates.length < 2) continue;

    const combo = findSummingCombo(candidates, oneRow.amount, [2, 3]);
    if (!combo) continue;

    const maxDateSpread = Math.max(
      ...combo.map((c) => daysBetween(c.date, oneRow.date))
    );
    const sizeScore = combo.length === 2 ? 0.9 : 0.75;
    const dateScore = 1 - maxDateSpread / (COMBO_DATE_WINDOW_DAYS + 1);
    const confidence = round2(0.35 + 0.4 * sizeScore * dateScore + 0.1 * sizeScore);

    oneMatchedIds.add(oneRow._id);
    for (const c of combo) manyMatchedIds.add(c._id);

    const comboRefs = combo.map((c) => c.ref).join(' + ');
    const comboDesc = combo.map((c) => c.desc).join(' | ');

    const bankRef = reversed ? comboRefs : oneRow.ref;
    const ledgerRef = reversed ? oneRow.ref : comboRefs;

    matches.push({
      bank_ref: bankRef,
      ledger_ref: ledgerRef,
      amount: oneRow.amount,
      status: 'matched',
      method: 'stage3_combo',
      confidence,
      reasoning: reversed
        ? `Split/combo match: ${combo.length} bank rows (${comboRefs}) sum to ${oneRow.amount.toFixed(2)}, matching ledger row ${oneRow.ref} within ${maxDateSpread} day(s). Component descriptions: ${comboDesc}.`
        : `Split/combo match: ${combo.length} ledger rows (${comboRefs}) sum to ${oneRow.amount.toFixed(2)}, matching bank row ${oneRow.ref} within ${maxDateSpread} day(s). Component descriptions: ${comboDesc}.`,
      _bank_id: reversed ? combo.map((c) => c._id) : oneRow._id,
      _ledger_ids: reversed ? [oneRow._id] : combo.map((c) => c._id),
      _combo_tag: tag,
    });
  }
}

/**
 * Brute-force search (candidate pools are small post-filtering, typically
 * under ~15 rows within a date window) for a subset of size 2 or 3 whose
 * amounts sum to `target` within AMOUNT_TOLERANCE. Returns the first match
 * found, tried smallest combo size first.
 */
function findSummingCombo(candidates, target, sizes) {
  const capped = candidates.slice(0, 20); // safety cap on combinatorial search
  for (const size of sizes) {
    const result = combosOfSize(capped, size, target);
    if (result) return result;
  }
  return null;
}

function combosOfSize(arr, size, target) {
  const n = arr.length;
  if (n < size) return null;
  const indices = [...Array(size).keys()];

  const tryCombo = (idxArr) => {
    const sum = idxArr.reduce((s, i) => s + arr[i].amount, 0);
    if (Math.abs(sum - target) <= AMOUNT_TOLERANCE) {
      return idxArr.map((i) => arr[i]);
    }
    return null;
  };

  while (true) {
    const hit = tryCombo(indices);
    if (hit) return hit;

    // advance indices (standard combination enumeration)
    let i = size - 1;
    while (i >= 0 && indices[i] === i + n - size) i--;
    if (i < 0) break;
    indices[i]++;
    for (let j = i + 1; j < size; j++) indices[j] = indices[j - 1] + 1;
  }
  return null;
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { comboMatchStage };
