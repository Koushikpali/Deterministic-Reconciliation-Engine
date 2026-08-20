const { daysBetween } = require('../utils/csvParser');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const NEAREST_CANDIDATES = 3;

/**
 * STAGE 4 — LLM EXCEPTION HANDLER
 * Only reached by rows that survive stages 1-3 unmatched.
 * For every remaining unmatched bank row, we send the row plus its top 3
 * "nearest" ledger candidates (by amount + date proximity) to Groq and ask
 * for a probable match + one-sentence reasoning.
 *
 * IMPORTANT: results here are ALWAYS flagged "flagged_for_review" regardless
 * of what the LLM reports — an LLM's self-reported confidence is not treated
 * as ground truth the way stages 1-3's deterministic confidence is.
 *
 * If no GROQ_API_KEY is configured, this stage degrades gracefully: every
 * remaining row is still logged with status "unresolved" and a reasoning
 * string explaining the LLM stage was skipped, so the audit trail never has
 * a silent gap.
 */
async function llmMatchStage(bankRows, ledgerRows) {
  const results = [];
  const apiKey = process.env.GROQ_API_KEY;

  for (const br of bankRows) {
    const nearest = nearestCandidates(br, ledgerRows, NEAREST_CANDIDATES);

    if (!apiKey) {
      results.push({
        bank_ref: br.ref,
        ledger_ref: null,
        amount: br.amount,
        status: 'unresolved',
        method: 'stage4_llm_skipped',
        confidence: null,
        reasoning: 'LLM exception stage skipped: no GROQ_API_KEY configured. Nearest candidates were: ' +
          (nearest.length ? nearest.map((c) => `${c.ref} (${c.amount.toFixed(2)}, ${c.date})`).join('; ') : 'none found') +
          '. Needs manual review.',
        _bank_id: br._id,
        _ledger_ids: [],
      });
      continue;
    }

    if (nearest.length === 0) {
      results.push({
        bank_ref: br.ref,
        ledger_ref: null,
        amount: br.amount,
        status: 'unresolved',
        method: 'stage4_llm',
        confidence: null,
        reasoning: 'No ledger candidates within reasonable amount/date proximity were found to send to the LLM. Likely a genuine one-sided exception (bank fee, FX adjustment, or unrecorded transaction).',
        _bank_id: br._id,
        _ledger_ids: [],
      });
      continue;
    }

    try {
      const llmResult = await callGroq(br, nearest, apiKey);
      const matchedCandidate = llmResult.probable_match_ref
        ? nearest.find((c) => c.ref === llmResult.probable_match_ref)
        : null;

      results.push({
        bank_ref: br.ref,
        ledger_ref: matchedCandidate ? matchedCandidate.ref : null,
        amount: br.amount,
        status: 'flagged_for_review',
        method: 'stage4_llm',
        confidence: typeof llmResult.confidence === 'number' ? llmResult.confidence : 0.5,
        reasoning: `${llmResult.reasoning} [LLM-assisted, always requires human sign-off]`,
        _bank_id: br._id,
        _ledger_ids: matchedCandidate ? [matchedCandidate._id] : [],
      });
    } catch (err) {
      results.push({
        bank_ref: br.ref,
        ledger_ref: null,
        amount: br.amount,
        status: 'unresolved',
        method: 'stage4_llm_error',
        confidence: null,
        reasoning: `LLM call failed (${err.message}). Nearest candidates were: ` +
          nearest.map((c) => `${c.ref} (${c.amount.toFixed(2)}, ${c.date})`).join('; ') +
          '. Needs manual review.',
        _bank_id: br._id,
        _ledger_ids: [],
      });
    }
  }

  // Any ledger rows never referenced by a matched/flagged result are also
  // genuine exceptions — log them so the audit trail is complete on both sides.
  const referencedLedgerIds = new Set(results.flatMap((r) => r._ledger_ids));
  for (const lr of ledgerRows) {
    if (referencedLedgerIds.has(lr._id)) continue;
    results.push({
      bank_ref: null,
      ledger_ref: lr.ref,
      amount: lr.amount,
      status: 'unresolved',
      method: 'stage4_llm_no_bank_side',
      confidence: null,
      reasoning: 'No corresponding bank-side transaction found or proposed by the LLM stage. Likely an invoice not yet paid, or payment recorded outside this statement period.',
      _bank_id: null,
      _ledger_ids: [lr._id],
    });
  }

  return results;
}

function nearestCandidates(bankRow, ledgerRows, count) {
  const scored = ledgerRows.map((lr) => {
    const dDiff = daysBetween(bankRow.date, lr.date);
    const amountDiffPct = Math.abs(bankRow.amount - lr.amount) / Math.max(bankRow.amount, 1);
    // Lower score = nearer. Weighted so amount closeness dominates.
    const score = amountDiffPct * 100 + dDiff * 0.5;
    return { ...lr, _score: score };
  });
  scored.sort((a, b) => a._score - b._score);
  return scored.slice(0, count);
}

async function callGroq(bankRow, candidates, apiKey) {
  const systemPrompt =
    'You are a financial reconciliation assistant. You will be given one unmatched bank transaction ' +
    'and up to three candidate ledger entries that survived deterministic matching but were not ' +
    'confidently matched. Decide whether ANY candidate is a plausible match for the bank transaction. ' +
    'Respond with ONLY a JSON object, no markdown fences, no preamble, in this exact shape: ' +
    '{"probable_match_ref": "<ledger ref or null>", "confidence": <number 0 to 1>, "reasoning": "<one sentence>"}';

  const userPrompt = JSON.stringify({
    bank_transaction: { ref: bankRow.ref, amount: bankRow.amount, date: bankRow.date, description: bankRow.desc },
    candidate_ledger_entries: candidates.map((c) => ({
      ref: c.ref, amount: c.amount, date: c.date, description: c.desc,
    })),
  });

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Groq API ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq API returned no content');

  const cleaned = content.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    probable_match_ref: parsed.probable_match_ref === 'null' ? null : parsed.probable_match_ref,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning || 'No reasoning provided by LLM.',
  };
}

module.exports = { llmMatchStage };
