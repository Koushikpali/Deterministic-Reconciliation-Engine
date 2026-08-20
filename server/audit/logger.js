const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DB_DIR, 'audit.sqlite');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    total_rows INTEGER,
    stage1_exact INTEGER,
    stage2_fuzzy INTEGER,
    stage3_combo INTEGER,
    stage4_llm INTEGER,
    unresolved INTEGER
  );

  CREATE TABLE IF NOT EXISTS audit_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    bank_ref TEXT,
    ledger_ref TEXT,
    amount REAL,
    status TEXT NOT NULL,
    method TEXT NOT NULL,
    confidence REAL,
    reasoning TEXT,
    FOREIGN KEY (run_id) REFERENCES runs (run_id)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_run_id ON audit_entries (run_id);
`);

const insertRunStmt = db.prepare(`
  INSERT INTO runs (run_id, created_at, total_rows, stage1_exact, stage2_fuzzy, stage3_combo, stage4_llm, unresolved)
  VALUES (@run_id, @created_at, @total_rows, @stage1_exact, @stage2_fuzzy, @stage3_combo, @stage4_llm, @unresolved)
`);

const insertEntryStmt = db.prepare(`
  INSERT INTO audit_entries (run_id, created_at, bank_ref, ledger_ref, amount, status, method, confidence, reasoning)
  VALUES (@run_id, @created_at, @bank_ref, @ledger_ref, @amount, @status, @method, @confidence, @reasoning)
`);

/**
 * Persists one full reconciliation run (append-only) — the summary row plus
 * every individual result row — to the SQLite audit log.
 */
function logRun(runId, summary, results) {
  const createdAt = new Date().toISOString();

  const insertMany = db.transaction(() => {
    insertRunStmt.run({
      run_id: runId,
      created_at: createdAt,
      total_rows: summary.total_rows,
      stage1_exact: summary.stage1_exact,
      stage2_fuzzy: summary.stage2_fuzzy,
      stage3_combo: summary.stage3_combo,
      stage4_llm: summary.stage4_llm,
      unresolved: summary.unresolved,
    });

    for (const r of results) {
      insertEntryStmt.run({
        run_id: runId,
        created_at: createdAt,
        bank_ref: Array.isArray(r.bank_ref) ? r.bank_ref.join('+') : r.bank_ref,
        ledger_ref: Array.isArray(r.ledger_ref) ? r.ledger_ref.join('+') : r.ledger_ref,
        amount: r.amount,
        status: r.status,
        method: r.method,
        confidence: r.confidence,
        reasoning: r.reasoning,
      });
    }
  });

  insertMany();
}

function getRun(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
  if (!run) return null;
  const entries = db.prepare('SELECT * FROM audit_entries WHERE run_id = ? ORDER BY id ASC').all(runId);
  return { run, entries };
}

function listRuns(limit = 20) {
  return db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = { logRun, getRun, listRuns, DB_PATH };
