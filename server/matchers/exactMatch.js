/**
 * STAGE 1 — EXACT MATCH
 * Match on: amount + date + reference number, all exact.
 * Confidence: 1.0 | Cost: 0 | Speed: instant
 *
 * Reference numbers rarely match verbatim between a bank feed and a ledger
 * (bank shows "TXN90151", ledger shows "INV-10194"), so we also allow an
 * exact match purely on (amount + date) when there's exactly one candidate
 * on each side for that (amount, date) pair — that's still a fully
 * deterministic, zero-ambiguity match, just not ref-based.
 */
function exactMatchStage(bankRows, ledgerRows) {
  const matches = [];
  const matchedBankIds = new Set();
  const matchedLedgerIds = new Set();

  // Index ledger rows by (amount, date) for O(1) lookup.
  const ledgerByKey = new Map();
  for (const lr of ledgerRows) {
    const key = `${lr.amount.toFixed(2)}|${lr.date}`;
    if (!ledgerByKey.has(key)) ledgerByKey.set(key, []);
    ledgerByKey.get(key).push(lr);
  }

  for (const br of bankRows) {
    const key = `${br.amount.toFixed(2)}|${br.date}`;
    const candidates = ledgerByKey.get(key);
    if (!candidates || candidates.length === 0) continue;

    // Prefer a candidate whose ref literally appears in the bank description
    // or vice versa — gives us a true ref-based exact match when possible.
    let chosen = null;
    let reasonDetail = '';
    if (candidates.length === 1) {
      chosen = candidates[0];
      reasonDetail = 'Unique amount+date match on both sides';
    } else {
      for (const c of candidates) {
        if (matchedLedgerIds.has(c._id)) continue;
        const refDigits = c.ref.replace(/[^0-9]/g, '');
        if (refDigits && (br.desc.includes(c.ref) || (refDigits.length >= 3 && br.desc.includes(refDigits)))) {
          chosen = c;
          reasonDetail = `Amount+date match, ledger ref "${c.ref}" found in bank description`;
          break;
        }
      }
    }

    if (!chosen) continue;
    if (matchedBankIds.has(br._id) || matchedLedgerIds.has(chosen._id)) continue;

    matchedBankIds.add(br._id);
    matchedLedgerIds.add(chosen._id);
    matches.push({
      bank_ref: br.ref,
      ledger_ref: chosen.ref,
      amount: br.amount,
      status: 'matched',
      method: 'stage1_exact',
      confidence: 1.0,
      reasoning: `Exact match: amount ${br.amount.toFixed(2)} and date ${br.date} identical on both sides. ${reasonDetail}.`,
      _bank_id: br._id,
      _ledger_ids: [chosen._id],
    });
  }

  const unmatchedBank = bankRows.filter((r) => !matchedBankIds.has(r._id));
  const unmatchedLedger = ledgerRows.filter((r) => !matchedLedgerIds.has(r._id));

  return { matches, unmatchedBank, unmatchedLedger };
}

module.exports = { exactMatchStage };
