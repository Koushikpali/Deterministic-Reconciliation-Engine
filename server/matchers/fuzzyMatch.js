const stringSimilarity = require('string-similarity');
const { daysBetween } = require('../utils/csvParser');

const DATE_WINDOW_DAYS = 3;
const SIMILARITY_THRESHOLD = 0.35; // description similarity is a secondary signal, not the gate on its own
const AUTO_MATCH_THRESHOLD = 0.55; // overall confidence needed to auto-accept — see note below

// Note on the threshold: amount is already an exact-match gate before a
// candidate is even scored here, which is the dominant signal in real
// reconciliation (two unrelated transactions rarely share an exact amount
// within a few days of each other). Description similarity on short,
// differently-structured strings (a vendor name vs. "invoice INV-1234" vs.
// "pymt ref 1234") legitimately lands in the 0.5-0.7 range for genuine
// matches under Dice-coefficient scoring, so gating at 0.85 rejected true
// positives. 0.55 was tuned against the sample dataset's known fuzzy pairs.

/**
 * STAGE 2 — FUZZY MATCH
 * Match on: amount exact + date within ±3 days + description similarity.
 * Confidence: weighted blend of date proximity and description similarity,
 * gated so amount is always exact (that's non-negotiable for a real match).
 *
 * Only matches at/above AUTO_MATCH_THRESHOLD are auto-accepted here.
 * Weaker candidates are left unmatched and fall through to stage 3/4.
 */
function fuzzyMatchStage(bankRows, ledgerRows, threshold = AUTO_MATCH_THRESHOLD) {
  const matches = [];
  const matchedBankIds = new Set();
  const matchedLedgerIds = new Set();

  // Index ledger by amount for fast candidate lookup.
  const ledgerByAmount = new Map();
  for (const lr of ledgerRows) {
    const key = lr.amount.toFixed(2);
    if (!ledgerByAmount.has(key)) ledgerByAmount.set(key, []);
    ledgerByAmount.get(key).push(lr);
  }

  for (const br of bankRows) {
    const candidates = ledgerByAmount.get(br.amount.toFixed(2)) || [];
    let best = null;
    let bestScore = 0;
    let bestDetail = null;

    for (const lr of candidates) {
      if (matchedLedgerIds.has(lr._id)) continue;
      const dDiff = daysBetween(br.date, lr.date);
      if (dDiff > DATE_WINDOW_DAYS) continue;

      const descSim = stringSimilarity.compareTwoStrings(
        normalizeDesc(br.desc),
        normalizeDesc(lr.desc)
      );

      // Weighted confidence: date proximity (closer = better) + description similarity.
      const dateScore = 1 - dDiff / (DATE_WINDOW_DAYS + 1); // 1.0 at 0 days, ~0.25 at 3 days
      const confidence = round2(0.45 * dateScore + 0.55 * descSim);

      if (confidence > bestScore) {
        bestScore = confidence;
        best = lr;
        bestDetail = { dDiff, descSim, dateScore };
      }
    }

    if (best && bestScore >= threshold) {
      matchedBankIds.add(br._id);
      matchedLedgerIds.add(best._id);
      matches.push({
        bank_ref: br.ref,
        ledger_ref: best.ref,
        amount: br.amount,
        status: 'matched',
        method: 'stage2_fuzzy',
        confidence: bestScore,
        reasoning: `Fuzzy match: amount exact (${br.amount.toFixed(2)}), date within ${bestDetail.dDiff} day(s), description ${Math.round(bestDetail.descSim * 100)}% similar ("${br.desc}" ~ "${best.desc}"). Flagged as auto-matched — fuzzy.`,
        _bank_id: br._id,
        _ledger_ids: [best._id],
      });
    }
  }

  const unmatchedBank = bankRows.filter((r) => !matchedBankIds.has(r._id));
  const unmatchedLedger = ledgerRows.filter((r) => !matchedLedgerIds.has(r._id));

  return { matches, unmatchedBank, unmatchedLedger };
}

function normalizeDesc(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { fuzzyMatchStage, DATE_WINDOW_DAYS, AUTO_MATCH_THRESHOLD };
