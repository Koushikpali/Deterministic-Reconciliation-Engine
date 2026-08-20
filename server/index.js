require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');

const { parseCsv } = require('./utils/csvParser');
const { runReconciliation } = require('./pipeline');
const { logRun, getRun, listRuns } = require('./audit/logger');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

/**
 * Builds a per-run progress emitter. If a client_id (the uploader's
 * socket.id) was supplied, stage events are pushed straight to that socket
 * so the frontend can render a live waterfall while /reconcile is running.
 */
function makeEmitter(clientId) {
  if (!clientId) return () => {};
  const socket = io.sockets.sockets.get(clientId);
  if (!socket) return () => {};
  return (event, data) => socket.emit('progress', { event, ...data });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    groq_configured: Boolean(process.env.GROQ_API_KEY),
    time: new Date().toISOString(),
  });
});

/**
 * POST /reconcile
 * Accepts two uploaded CSV files: `bank_statement` and `ledger`.
 * Runs the full 4-stage waterfall and returns { run_id, summary, results }.
 * Also persists the run to the append-only SQLite audit log.
 */
app.post(
  '/reconcile',
  upload.fields([
    { name: 'bank_statement', maxCount: 1 },
    { name: 'ledger', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const bankFile = req.files?.bank_statement?.[0];
      const ledgerFile = req.files?.ledger?.[0];

      if (!bankFile || !ledgerFile) {
        return res.status(400).json({
          error: 'Both "bank_statement" and "ledger" CSV files are required (multipart/form-data fields).',
        });
      }

      const bankRows = parseCsv(bankFile.buffer.toString('utf-8'), 'bank');
      const ledgerRows = parseCsv(ledgerFile.buffer.toString('utf-8'), 'ledger');

      if (bankRows.length === 0 || ledgerRows.length === 0) {
        return res.status(400).json({
          error: 'One or both CSVs parsed to zero valid rows. Expected columns: date, amount, ref, desc.',
        });
      }

      const emit = makeEmitter(req.body.client_id);
      const { summary, results } = await runReconciliation(bankRows, ledgerRows, emit);

      const runId = uuidv4();
      logRun(runId, summary, results);

      res.json({ run_id: runId, summary, results });
    } catch (err) {
      console.error('Reconciliation error:', err);
      res.status(500).json({ error: err.message || 'Internal error running reconciliation.' });
    }
  }
);

/**
 * POST /reconcile/sample
 * Convenience endpoint for demos: runs the pipeline against the bundled
 * sample-data/bank_statement.csv and sample-data/ledger.csv without
 * requiring a file upload.
 */
app.post('/reconcile/sample', async (req, res) => {
  try {
    const bankPath = path.join(__dirname, '..', 'sample-data', 'bank_statement.csv');
    const ledgerPath = path.join(__dirname, '..', 'sample-data', 'ledger.csv');

    if (!fs.existsSync(bankPath) || !fs.existsSync(ledgerPath)) {
      return res.status(404).json({
        error: 'Sample data not found. Run `npm run generate-data` first.',
      });
    }

    const bankRows = parseCsv(fs.readFileSync(bankPath, 'utf-8'), 'bank');
    const ledgerRows = parseCsv(fs.readFileSync(ledgerPath, 'utf-8'), 'ledger');

    const emit = makeEmitter(req.body.client_id || req.query.client_id);
    const { summary, results } = await runReconciliation(bankRows, ledgerRows, emit);

    const runId = uuidv4();
    logRun(runId, summary, results);

    res.json({ run_id: runId, summary, results });
  } catch (err) {
    console.error('Sample reconciliation error:', err);
    res.status(500).json({ error: err.message || 'Internal error running sample reconciliation.' });
  }
});

/** GET /runs — list recent reconciliation runs (summary only). */
app.get('/runs', (req, res) => {
  res.json({ runs: listRuns(50) });
});

/** GET /runs/:id — full audit trail for one run. */
app.get('/runs/:id', (req, res) => {
  const data = getRun(req.params.id);
  if (!data) return res.status(404).json({ error: 'Run not found.' });
  res.json(data);
});

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

server.listen(PORT, () => {
  console.log(`Reconciliation engine listening on http://localhost:${PORT}`);
  console.log(`Groq LLM stage: ${process.env.GROQ_API_KEY ? 'ENABLED' : 'DISABLED (no GROQ_API_KEY — stage 4 will log unresolved rows without calling the LLM)'}`);
});

module.exports = app;
