# Zenalyst — Deterministic Reconciliation Engine

A deterministic-first bank-to-ledger reconciliation pipeline that mirrors real treasury workflows. It uses fast, explainable logic for the vast majority of matches and only asks an LLM to assist on genuinely ambiguous leftovers—ensuring auditability, explainability, and conservative AI usage.

## One-line summary
Deterministic matching (exact, fuzzy, split/combo) first; LLM only for exceptions. Every decision is logged with a method, computed confidence, and a plain-English reason.

## Why this matters
Most "AI reconciliation" demos throw two CSVs at an LLM and hope for the best. That approach is fast to build but impossible to audit and unacceptable to finance teams that need traceability. Zenalyst performs deterministic matching first (the parts humans expect to be deterministic), and reserves the LLM for a small set of ambiguous rows. Every result—deterministic or AI-assisted—gets an append-only audit entry explaining why it was chosen and how confident the system is.

## Key features
- Deterministic-first, multi-stage waterfall matching:
  - Exact matches (amount + date [+ reference when available)
  - Fuzzy matches (amount exact + date window + description similarity)
  - Split/combo matches (2–3 rows sum to one row)
  - LLM exception handler for ambiguous cases (always flagged for review)
- Full, append-only audit trail in SQLite with per-row reasoning and confidence
- Graceful degradation if LLM credentials are not configured (no silent failures)
- Small, dependency-light Node.js implementation suitable for demos and production prototyping

## How it works (4-stage waterfall)
1. Stage 1 — Exact match
   - amount + date + reference (or unique amount+date pair)
   - Confidence: 1.00 — deterministic and instant
2. Stage 2 — Fuzzy match
   - amount exact + date within ±3 days + description similarity
   - Confidence: computed (typically 0.55–0.95); auto-accepted above a threshold
3. Stage 3 — Split / combo match
   - detect 2–3 rows on one side that sum to a single row on the other
   - Confidence: 0.60–0.90 depending on size and date spread
4. Stage 4 — LLM exception handler (Groq)
   - send an unmatched row + up to 3 nearest candidates to an LLM
   - LLM response is always flagged for human review; never taken as final
   - If no GROQ API key, rows are logged as `unresolved` with preserved nearest-candidate context

All stages only operate on rows the previous stage left unmatched. Every row in the final output includes: status, method, confidence, and a short human-readable reason. All outputs are persisted to SQLite for auditability.

## Tech stack
- Language: JavaScript (Node.js, CommonJS)
- Runtime / Frameworks: Node.js + Express
- Notable libraries:
  - better-sqlite3 (audit log)
  - papaparse (CSV parsing)
  - fastest-levenshtein / string-similarity (fuzzy matching)
  - multer (multipart uploads)
  - uuid (run ids)

## Project layout
```
recon-engine/
├── server/
│   ├── index.js              # Express app + routes
│   ├── pipeline.js           # Orchestrates stages 1→2→3→4
│   ├── matchers/             # Matching stage implementations
│   │   ├── exactMatch.js
│   │   ├── fuzzyMatch.js
│   │   ├── comboMatch.js
│   │   └── llmMatch.js
│   ├── audit/
│   │   └── logger.js         # SQLite append-only audit persistence
│   └── utils/
│       └── csvParser.js      # CSV parsing + helpers
├── sample-data/
│   ├── generate.js           # Re-generate seeded sample dataset
│   ├── bank_statement.csv
│   └── ledger.csv
├── data/                     # audit.sqlite (gitignored)
├── .env.example
└── package.json
```

How it fits together
- `server/index.js` exposes HTTP endpoints and invokes `pipeline.runReconciliation`.
- `server/pipeline.js` runs exact → fuzzy → combo → llm stages, builds a summary and flattened result list, and returns them to the caller.
- `server/audit/logger.js` persists the summary and every individual result into an append-only SQLite database (`data/audit.sqlite`).
- Stage implementations live under `server/matchers/` and operate only on rows not resolved by prior stages.

## Quick start (local)
Requirements: Node.js (16+ recommended)

```bash
git clone https://github.com/<your-org>/zenalyst.git
cd zenalyst
npm install
cp .env.example .env        # set GROQ_API_KEY if you want Stage 4 enabled
npm run generate-data       # optional: regenerates sample dataset
npm start                   # starts server on :4000
```

Env vars
- GROQ_API_KEY — (optional) API key for Groq LLM. If absent, Stage 4 will log `unresolved` entries instead of calling the LLM.
- GROQ_MODEL — optional model override (defaults to `llama-3.3-70b-versatile`)
- PORT — optional port (defaults to 4000)

## HTTP endpoints
- GET /health
  - Liveness check and Groq configuration status
- POST /reconcile
  - Run the pipeline with uploaded CSVs (multipart form-data)
  - Fields: `bank_statement` (file), `ledger` (file)
- POST /reconcile/sample
  - Run against the bundled sample CSVs (no upload required)
- GET /runs
  - List recent reconciliation runs (summary rows)
- GET /runs/:id
  - Full audit trail for a specific run

Example: run the sample demo
```bash
curl -X POST http://localhost:4000/reconcile/sample | python3 -m json.tool
```

Upload your own CSVs (columns: `date, amount, ref, desc`)
```bash
curl -X POST http://localhost:4000/reconcile \
  -F "bank_statement=@/path/to/your/bank_statement.csv" \
  -F "ledger=@/path/to/your/ledger.csv"
```

Response shape (example)
```json
{
  "run_id": "04829e84-...",
  "summary": {
    "total_bank_rows": 176,
    "total_ledger_rows": 203,
    "stage1_exact": 100,
    "stage2_fuzzy": 22,
    "stage3_combo": 20,
    "stage4_llm": 11,
    "unresolved": 4,
    "pct_resolved_deterministically": 82.8,
    "pct_needs_llm_or_review": 17.2
  },
  "results": [
    {
      "bank_ref": "TXN90151",
      "ledger_ref": "INV-10194",
      "amount": 80038.69,
      "status": "matched",
      "method": "stage1_exact",
      "confidence": 1,
      "reasoning": "Exact match: amount 80038.69 and date 2026-06-27 identical on both sides."
    }
  ]
}
```

## Data & audit
- SQLite database: `data/audit.sqlite` (created automatically; folder is gitignored)
- Schema:
  - `runs` — summary per run (run_id, created_at, counts)
  - `audit_entries` — one row per reconciliation result with reasoning & confidence
- Append-only intent: runs and entries are always inserted; nothing is overwritten. This makes the audit trail reconstructible.

## Design notes & tuning
- Fuzzy threshold: tuned to the sample dataset so description similarity is a secondary signal. Amount exactness is always required for fuzzy matching.
- Combo search: brute-force checking for 2–3 item combos, capped at the first 20 candidate rows to keep combinatorics small. This is fine for demo and moderate volumes; larger volumes would need DP/optimized algorithms.
- LLM usage: LLM outputs are always `flagged_for_review` — never treated as deterministic. If the Groq key is missing, the system logs `unresolved` entries along with nearest candidate context so manual review can proceed.
- Confidence values are computed by documented formulas (date proximity, string similarity, combo size/spread) — they are inspectable and tunable, not arbitrary.

## Sample dataset
`sample-data/generate.js` produces a seeded dataset with:
- Exact matches (~100)
- Fuzzy matches with typographical/name drift (~30)
- Split/combo payments (~20 groups)
- Genuine one-sided exceptions (~10)
- Near-miss decoys (same amount but different vendor, etc.)

Re-run `npm run generate-data` to regenerate the sample data (seeded for reproducibility).

## Tests & development
- Start server: `npm start`
- Development: use `npm run dev` (currently an alias to start)
- Add tests: none included by default — recommended to add unit tests for matcher functions and integration tests for the end-to-end pipeline.

## Contributing
- Open an issue for feature requests or bugs.
- PRs should include tests for matcher behavior when applicable and update design notes if algorithm behavior changes.

## License
MIT
