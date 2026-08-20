# Deterministic Reconciliation Engine

A bank-to-ledger reconciliation pipeline built the way real treasury-ops
tools (Tesorio, Trovata, HighRadius) actually work — not the way most "AI
reconciliation" demos work.

## The pitch, in one paragraph

Most AI reconciliation demos dump two CSVs into an LLM and ask "match
these." That's fast to build and impossible to audit — nobody can tell you
*why* the model matched row 47 to row 112, and a finance team will never
trust a black box with their books. This engine does the opposite: cheap,
deterministic, fully explainable logic handles as much of the matching as
possible first. The LLM is only called on the genuinely ambiguous leftover
— typically 10-20% of rows. Every single decision, deterministic or
AI-assisted, is logged with a method, a confidence score, and a
plain-English reason. On the bundled sample data, **82.8% of rows resolve
without ever touching an LLM.**

## Why this matters (for a non-technical read)

Imagine handing a bookkeeper 400 transactions and asking them to match your
bank statement against your invoices. A good bookkeeper doesn't guess —
they do the obvious matches first (same amount, same date, same reference
number — done in seconds), then the slightly-trickier ones (same amount,
date off by a day or two, vendor name spelled slightly differently), then
the genuinely tricky ones (one deposit that's actually three invoices paid
together). Only the handful left over — the ones even a careful human would
raise an eyebrow at — go to someone senior for judgment.

This engine mirrors that exact workflow. It does not use AI to guess at
everything; it uses AI *only* where deterministic rules run out, and it
never lets the AI's word be final — every AI-touched row is flagged for a
human to sign off on, no exceptions.

## The 4-stage waterfall

```
bank_statement.csv          ledger.csv
        │                        │
        └───────────┬────────────┘
                     ▼
   STAGE 1 — EXACT MATCH
   amount + date + reference, all exact (or a unique amount+date
   pair when refs don't literally match across systems).
   Confidence: 1.00 · Cost: $0 · Instant.
                     │ (leftover rows only)
                     ▼
   STAGE 2 — FUZZY MATCH
   amount exact + date within ±3 days + description similarity
   (Dice-coefficient string matching, catches typos like
   "Bluepeak Logistcs" vs "Bluepeak Logistics").
   Confidence: 0.55-0.95, scored not guessed.
                     │ (leftover rows only)
                     ▼
   STAGE 3 — SPLIT / COMBO MATCH
   Do 2-3 leftover rows on one side sum to one row on the other?
   (One bank deposit = three invoices paid in a batch — the
   single most common "why doesn't this reconcile" case in
   real treasury ops.)
   Confidence: 0.60-0.90, scaled down as more rows combine.
                     │ (true exceptions only — 10-20% of total)
                     ▼
   STAGE 4 — LLM EXCEPTION HANDLER (Groq)
   Sends the unmatched row + its 3 nearest candidates to an LLM,
   asks for a probable match and a one-sentence reason.
   ALWAYS flagged "needs human review" — the LLM's own confidence
   is never treated as final, unlike stages 1-3.
                     │
                     ▼
        AUDIT LOG + JSON SUMMARY
   Every row → { status, method, confidence, reasoning }
   Append-only, stored in SQLite.
```

Each stage only ever sees what the previous stage failed to resolve —
nothing is re-checked, nothing is double-counted, and the cost of the
expensive step (the LLM call) scales with genuine ambiguity, not with the
size of the dataset.

## What makes this "audit-grade" rather than a toy

- **Every row gets a reason**, not just a yes/no. `"Fuzzy match: amount
  exact (90647.45), date within 1 day(s), description 68% similar"` is
  something a finance controller can actually verify by eye.
- **Confidence is computed, not asserted.** Stage 1 is always 1.0 because
  it's a literal exact match. Stage 2/3 confidence comes from a documented
  formula (date proximity + string similarity, or combo size + date
  spread) — it's inspectable and tunable, not a black-box number.
- **The LLM never gets the final word.** Every stage-4 result is forced to
  `status: "flagged_for_review"` regardless of what the model reports.
  That's a deliberate design choice, not an oversight.
- **Append-only audit trail.** Every run is persisted to SQLite
  (`data/audit.sqlite`) — nothing is overwritten, so you can reconstruct
  exactly what happened on any past run.
- **Graceful degradation.** If no `GROQ_API_KEY` is set, or the LLM call
  fails, the pipeline doesn't crash or silently drop rows — it logs them as
  `unresolved` with the reason why, so the audit trail never has a gap.

## Tech stack

- **Backend:** Node.js + Express
- **Matching logic:** plain JS — `fastest-levenshtein` / `string-similarity`
  for Stage 2, brute-force subset-sum (capped, small candidate pools) for
  Stage 3
- **LLM fallback:** Groq API (`llama-3.3-70b-versatile` by default)
- **CSV parsing:** `papaparse`
- **Audit log:** SQLite via `better-sqlite3` (WAL mode, append-only)

## Project layout

```
recon-engine/
├── server/
│   ├── index.js              Express app, routes
│   ├── pipeline.js           Orchestrates stages 1→2→3→4
│   ├── matchers/
│   │   ├── exactMatch.js     Stage 1
│   │   ├── fuzzyMatch.js     Stage 2
│   │   ├── comboMatch.js     Stage 3
│   │   └── llmMatch.js       Stage 4 (Groq)
│   ├── audit/
│   │   └── logger.js         SQLite persistence
│   └── utils/
│       └── csvParser.js
├── sample-data/
│   ├── generate.js           Regenerates the demo dataset (seeded, reproducible)
│   ├── bank_statement.csv    ~176 rows
│   └── ledger.csv            ~203 rows
├── data/                     audit.sqlite lives here (gitignored)
├── .env.example
└── package.json
```

## Running it

```bash
npm install
cp .env.example .env        # add your GROQ_API_KEY to enable Stage 4
npm run generate-data       # (already generated — re-run to reshuffle)
npm start                   # listens on :4000
```

### Endpoints

| Method | Path                | What it does                                                        |
|--------|---------------------|-----------------------------------------------------------------------|
| GET    | `/health`            | Liveness check, shows whether Groq is configured                     |
| POST   | `/reconcile`         | Upload `bank_statement` + `ledger` CSVs (multipart/form-data), runs the full pipeline |
| POST   | `/reconcile/sample`  | Runs the pipeline against the bundled sample CSVs — no upload needed, good for a live demo |
| GET    | `/runs`              | Lists past reconciliation runs (summary only)                        |
| GET    | `/runs/:id`          | Full audit trail for one run                                         |

### Quick demo

```bash
curl -X POST http://localhost:4000/reconcile/sample | python3 -m json.tool
```

Response shape:

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

To upload your own CSVs (columns: `date, amount, ref, desc`):

```bash
curl -X POST http://localhost:4000/reconcile \
  -F "bank_statement=@sample-data/bank_statement.csv" \
  -F "ledger=@sample-data/ledger.csv"
```

## Sample dataset

`sample-data/generate.js` produces a seeded (reproducible) dataset mixing:
- Exact matches (~100 pairs)
- Fuzzy matches with vendor-name typos and ±1-3 day drift (~33 pairs)
- Split/combo payments — one deposit covering 2-3 invoices (~20 groups)
- Genuine one-sided exceptions — bank fees, FX adjustments, unpaid invoices (~11)
- Near-miss decoys designed to *look* matchable but shouldn't be — same
  amount/wrong vendor, same vendor/wrong amount (~16) — these exist
  specifically to prove the matchers don't false-positive under pressure

Re-run `npm run generate-data` any time to get a fresh shuffle (same seed,
same composition, different row ordering).

## Design notes / things worth knowing before a demo

- **Fuzzy match threshold (0.55):** description similarity on short,
  differently-structured strings (a vendor name vs. `"invoice INV-1234"`
  vs. `"pymt ref 1234"`) legitimately scores 0.5-0.7 for genuine matches
  under Dice-coefficient scoring — amount is already an exact-match gate
  before a candidate is even scored, which is the dominant signal in real
  reconciliation. The threshold was tuned against the sample dataset's
  known fuzzy pairs and can be adjusted per-deployment.
- **Combo search is capped** at the first 20 date-window candidates per
  side to keep the subset-sum search fast — fine for realistic per-day
  transaction volumes, would need a smarter algorithm (DP subset-sum) at
  much higher volume.
- **Stage 4 without a Groq key** doesn't stub out fake results — it logs
  real `unresolved` rows with the nearest-candidate context preserved, so
  swapping in a key later doesn't change anything about the audit trail's
  shape.
#   z e n a l y s t  
 