const Papa = require('papaparse');

/**
 * Parses a CSV buffer/string into an array of normalized row objects.
 * Expected columns (case-insensitive): date, amount, ref, desc
 * Each row is tagged with a stable `_id` (its 0-based index in the file)
 * used internally to track matches without mutating original refs.
 */
function parseCsv(csvString, sourceLabel) {
  const parsed = Papa.parse(csvString.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  if (parsed.errors && parsed.errors.length > 0) {
    const fatal = parsed.errors.filter((e) => e.type !== 'FieldMismatch');
    if (fatal.length > 0) {
      throw new Error(`CSV parse error in ${sourceLabel}: ${fatal[0].message}`);
    }
  }

  const rows = parsed.data.map((row, idx) => {
    const amountRaw = (row.amount ?? '').toString().replace(/[,₹$\s]/g, '');
    const amount = parseFloat(amountRaw);
    const dateRaw = (row.date ?? '').toString().trim();
    const date = normalizeDate(dateRaw);

    return {
      _id: `${sourceLabel}_${idx}`,
      _source: sourceLabel,
      date,
      dateRaw,
      amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : NaN,
      ref: (row.ref ?? '').toString().trim(),
      desc: (row.desc ?? '').toString().trim(),
    };
  }).filter((r) => r.date && Number.isFinite(r.amount));

  return rows;
}

function normalizeDate(raw) {
  if (!raw) return null;
  // Handles YYYY-MM-DD directly; falls back to Date parsing for other formats.
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoMatch) return raw;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  const diffMs = Math.abs(a.getTime() - b.getTime());
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

module.exports = { parseCsv, normalizeDate, daysBetween };
