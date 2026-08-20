const { exactMatchStage } = require('./matchers/exactMatch');
const { fuzzyMatchStage } = require('./matchers/fuzzyMatch');
const { comboMatchStage } = require('./matchers/comboMatch');
const { llmMatchStage } = require('./matchers/llmMatch');

/**
 * Runs the full deterministic-first waterfall:
 *   Stage 1 exact -> Stage 2 fuzzy -> Stage 3 combo -> Stage 4 LLM exception
 * Each stage only ever sees rows the previous stage failed to resolve.
 * Returns { summary, results } where results is the flat audit-log shape
 * described in the project spec: { bank_ref, ledger_ref, amount, status,
 * method, confidence, reasoning }.
 */
async function runReconciliation(bankRows, ledgerRows, onProgress) {
  const emit = typeof onProgress === 'function' ? onProgress : () => {};
  const totalRows = bankRows.length + ledgerRows.length;

  emit('started', { total_bank_rows: bankRows.length, total_ledger_rows: ledgerRows.length });

  const stage1 = exactMatchStage(bankRows, ledgerRows);
  emit('stage_complete', {
    stage: 1,
    label: 'Exact match',
    matched: stage1.matches.length,
    remaining: stage1.unmatchedBank.length + stage1.unmatchedLedger.length,
  });

  const stage2 = fuzzyMatchStage(stage1.unmatchedBank, stage1.unmatchedLedger);
  emit('stage_complete', {
    stage: 2,
    label: 'Fuzzy match',
    matched: stage2.matches.length,
    remaining: stage2.unmatchedBank.length + stage2.unmatchedLedger.length,
  });

  const stage3 = comboMatchStage(stage2.unmatchedBank, stage2.unmatchedLedger);
  emit('stage_complete', {
    stage: 3,
    label: 'Split / combo match',
    matched: stage3.matches.length,
    remaining: stage3.unmatchedBank.length + stage3.unmatchedLedger.length,
  });

  emit('stage_started', { stage: 4, label: 'LLM exception handler (Groq)' });
  const stage4Results = await llmMatchStage(stage3.unmatchedBank, stage3.unmatchedLedger);
  emit('stage_complete', {
    stage: 4,
    label: 'LLM exception handler',
    flagged: stage4Results.filter((r) => r.status === 'flagged_for_review').length,
    unresolved: stage4Results.filter((r) => r.status === 'unresolved').length,
  });

  const allResults = [
    ...stage1.matches,
    ...stage2.matches,
    ...stage3.matches,
    ...stage4Results,
  ].map(stripInternalFields);

  const summary = {
    total_bank_rows: bankRows.length,
    total_ledger_rows: ledgerRows.length,
    total_rows: totalRows,
    stage1_exact: stage1.matches.length,
    stage2_fuzzy: stage2.matches.length,
    stage3_combo: stage3.matches.length,
    stage4_llm: stage4Results.filter((r) => r.status === 'flagged_for_review').length,
    unresolved: stage4Results.filter((r) => r.status === 'unresolved').length,
  };

  const resolvedRowUnits =
    stage1.matches.length * 2 +
    stage2.matches.length * 2 +
    stage3.matches.reduce((sum, m) => sum + (Array.isArray(m._ledger_ids) ? m._ledger_ids.length : 1) + (Array.isArray(m._bank_id) ? m._bank_id.length : 1), 0);

  summary.pct_resolved_deterministically = totalRows > 0
    ? round1(100 * (resolvedRowUnits / totalRows))
    : 0;
  summary.pct_needs_llm_or_review = totalRows > 0
    ? round1(100 - summary.pct_resolved_deterministically)
    : 0;

  emit('done', { summary });

  return { summary, results: allResults };
}

function stripInternalFields(r) {
  const { _bank_id, _ledger_ids, _combo_tag, ...clean } = r;
  return clean;
}

function round1(n) { return Math.round(n * 10) / 10; }

module.exports = { runReconciliation };
