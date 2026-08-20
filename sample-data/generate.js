/**
 * Generates realistic sample_data/bank_statement.csv and sample_data/ledger.csv
 * for demoing the reconciliation engine.
 *
 * Mix produced (target ~180 bank rows / ~185 ledger rows):
 *   - Exact matches            (~55%)  -> amount + date + ref all identical
 *   - Fuzzy matches            (~18%)  -> amount identical, date drifted ±1-3 days,
 *                                         description has typos/reordering/vendor-name variants
 *   - Split / combo matches    (~12%)  -> one bank deposit = 2-3 ledger invoice payments
 *   - Genuine unresolved       (~6%)   -> bank-only or ledger-only rows with no real counterpart
 *   - Near-miss decoys         (~9%)   -> rows that look tempting to match but shouldn't
 *                                         (same amount wrong vendor, same vendor wrong amount)
 *
 * Run: node sample-data/generate.js
 */
const fs = require('fs');
const path = require('path');

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rand = seededRandom(42);
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[randInt(0, arr.length - 1)];
const round2 = (n) => Math.round(n * 100) / 100;

const VENDORS = [
  'Acme Supplies Ltd', 'Nimbus Cloud Services', 'Bluepeak Logistics', 'Orbit Manufacturing',
  'Vertex Consulting Group', 'Harbor Freight Traders', 'Silverline Textiles', 'Northgate Retailers',
  'Crestview Analytics', 'Pinecrest Realty', 'Sunrise Foods Pvt Ltd', 'Meridian Insurance Co',
  'Falcon Freight Systems', 'Ironclad Security Services', 'Zenith Marketing Agency',
  'Quantum Office Supplies', 'Redwood Construction', 'Coral Bay Hospitality', 'Aster Pharma Ltd',
  'Brightline Telecom', 'Copperfield Legal Associates', 'Delta Machine Works', 'Everwood Furniture',
  'Granite Point Bank', 'Hilltop Energy Corp'
];

const VENDOR_TYPOS = {
  'Acme Supplies Ltd': ['ACME SUPLIES LTD', 'Acme Supplies Limited', 'ACME SUPPLIES'],
  'Nimbus Cloud Services': ['NIMBUS CLD SVCS', 'Nimbus Cloud Svc', 'NIMBUS CLOUD SERVICE'],
  'Bluepeak Logistics': ['BLUE PEAK LOGISTICS', 'Bluepeak Logistcs', 'BLUEPEAK LOG'],
  'Orbit Manufacturing': ['ORBIT MFG', 'Orbit Manufactring', 'ORBIT MANUFACTURING CO'],
  'Vertex Consulting Group': ['VERTEX CONSULTING', 'Vertex Consult Grp', 'VERTEX CONSLTNG GRP'],
  'Harbor Freight Traders': ['HARBOUR FREIGHT TRADERS', 'Harbor Frieght Traders', 'HARBOR FRT TRADERS'],
  'Silverline Textiles': ['SILVER LINE TEXTILES', 'Silverline Textile', 'SILVERLINE TXT'],
  'Northgate Retailers': ['NORTH GATE RETAILERS', 'Northgate Retailer', 'NORTHGATE RTLRS'],
  'Crestview Analytics': ['CREST VIEW ANALYTICS', 'Crestview Analytic', 'CRESTVIEW ANLYTCS'],
  'Pinecrest Realty': ['PINE CREST REALTY', 'Pinecrest Realty LLC', 'PINECREST RLTY'],
  'Sunrise Foods Pvt Ltd': ['SUNRISE FOODS PVT. LTD.', 'Sunrise Food Pvt Ltd', 'SUNRISE FOODS'],
  'Meridian Insurance Co': ['MERIDIAN INSURANCE COMPANY', 'Meridian Insur Co', 'MERIDIAN INS CO'],
  'Falcon Freight Systems': ['FALCON FRIEGHT SYSTEMS', 'Falcon Freight Sys', 'FALCON FRT SYSTEMS'],
  'Ironclad Security Services': ['IRON CLAD SECURITY SVCS', 'Ironclad Security Svc', 'IRONCLAD SEC SERVICES'],
  'Zenith Marketing Agency': ['ZENITH MKTG AGENCY', 'Zenith Marketing Agncy', 'ZENITH MARKETING AGCY'],
  'Quantum Office Supplies': ['QUANTUM OFFICE SUPPLY', 'Quantum Ofc Supplies', 'QUANTUM OFFICE SUPLS'],
  'Redwood Construction': ['RED WOOD CONSTRUCTION', 'Redwood Constrction', 'REDWOOD CONSTR'],
  'Coral Bay Hospitality': ['CORALBAY HOSPITALITY', 'Coral Bay Hospitlity', 'CORAL BAY HOSP'],
  'Aster Pharma Ltd': ['ASTER PHARMA LIMITED', 'Aster Pharma Pvt Ltd', 'ASTER PHRMA LTD'],
  'Brightline Telecom': ['BRIGHT LINE TELECOM', 'Brightline Telcom', 'BRIGHTLINE TEL'],
  'Copperfield Legal Associates': ['COPPERFIELD LEGAL ASSOC', 'Copperfield Legal Assoc.', 'COPPERFIELD LGL ASSOCIATES'],
  'Delta Machine Works': ['DELTA MACHINEWORKS', 'Delta Machine Wrks', 'DELTA MCHN WORKS'],
  'Everwood Furniture': ['EVER WOOD FURNITURE', 'Everwood Furnitures', 'EVERWOOD FURN'],
  'Granite Point Bank': ['GRANITEPOINT BANK', 'Granite Pt Bank', 'GRANITE POINT BK'],
  'Hilltop Energy Corp': ['HILL TOP ENERGY CORP', 'Hilltop Energy Corporation', 'HILLTOP ENRGY CORP']
};

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }

const START_DATE = new Date('2026-05-01');
let refCounter = 10000;
let txnCounter = 90000;
function nextInvoiceRef() { refCounter += randInt(1, 4); return `INV-${refCounter}`; }
function nextTxnRef() { txnCounter += randInt(1, 3); return `TXN${txnCounter}`; }

const bankRows = [];
const ledgerRows = [];

function addExactMatch() {
  const date = addDays(START_DATE, randInt(0, 89));
  const amount = round2(randInt(500, 500000) / 1.37);
  const vendor = pick(VENDORS);
  const invRef = nextInvoiceRef();
  const txnRef = nextTxnRef();
  bankRows.push({ date: fmtDate(date), amount, ref: txnRef, desc: `${vendor} - ${invRef} payment` });
  ledgerRows.push({ date: fmtDate(date), amount, ref: invRef, desc: `${vendor} invoice ${invRef}`, bank_ref: txnRef });
}

function addFuzzyMatch() {
  const ledgerDate = addDays(START_DATE, randInt(0, 89));
  const drift = randInt(1, 3) * (rand() < 0.5 ? -1 : 1);
  const bankDate = addDays(ledgerDate, drift);
  const amount = round2(randInt(500, 500000) / 1.37);
  const vendor = pick(VENDORS);
  const invRef = nextInvoiceRef();
  const txnRef = nextTxnRef();
  const typoVariants = VENDOR_TYPOS[vendor];
  const bankVendorText = pick(typoVariants);
  ledgerRows.push({ date: fmtDate(ledgerDate), amount, ref: invRef, desc: `${vendor} invoice ${invRef}` });
  bankRows.push({ date: fmtDate(bankDate), amount, ref: txnRef, desc: `${bankVendorText} pymt ref ${invRef.replace('INV-', '')}` });
}

function addSplitMatch() {
  // one bank deposit == sum of 2-3 ledger invoice payments
  const date = addDays(START_DATE, randInt(0, 89));
  const vendor = pick(VENDORS);
  const parts = randInt(2, 3);
  let total = 0;
  const txnRef = nextTxnRef();
  const invRefs = [];
  for (let i = 0; i < parts; i++) {
    const partAmount = round2(randInt(2000, 80000) / 1.11);
    total = round2(total + partAmount);
    const invRef = nextInvoiceRef();
    invRefs.push(invRef);
    const ledgerDate = addDays(date, randInt(-2, 0));
    ledgerRows.push({ date: fmtDate(ledgerDate), amount: partAmount, ref: invRef, desc: `${vendor} invoice ${invRef}` });
  }
  bankRows.push({ date: fmtDate(date), amount: total, ref: txnRef, desc: `${vendor} - combined settlement ${invRefs.join('+')}` });
}

function addUnresolved() {
  // genuine one-sided exceptions: bank-only (e.g. bank fee, unexplained deposit)
  // or ledger-only (e.g. invoice not yet paid / payment lost)
  if (rand() < 0.5) {
    const date = addDays(START_DATE, randInt(0, 89));
    const amount = round2(randInt(200, 15000) / 1.17);
    const txnRef = nextTxnRef();
    const kind = pick(['Bank service charge', 'Unidentified wire transfer', 'FX conversion adjustment', 'Interest credit']);
    bankRows.push({ date: fmtDate(date), amount, ref: txnRef, desc: kind });
  } else {
    const date = addDays(START_DATE, randInt(0, 89));
    const amount = round2(randInt(1000, 90000) / 1.09);
    const vendor = pick(VENDORS);
    const invRef = nextInvoiceRef();
    ledgerRows.push({ date: fmtDate(date), amount, ref: invRef, desc: `${vendor} invoice ${invRef} (payment pending)` });
  }
}

function addNearMissDecoy() {
  // Same amount, different vendor+date far apart (should NOT match)
  // or same vendor, different amount (should NOT match)
  const date1 = addDays(START_DATE, randInt(0, 89));
  const amount = round2(randInt(1000, 90000) / 1.23);
  if (rand() < 0.5) {
    const vendorA = pick(VENDORS);
    let vendorB = pick(VENDORS);
    while (vendorB === vendorA) vendorB = pick(VENDORS);
    const invRef = nextInvoiceRef();
    const txnRef = nextTxnRef();
    ledgerRows.push({ date: fmtDate(date1), amount, ref: invRef, desc: `${vendorA} invoice ${invRef}` });
    bankRows.push({ date: fmtDate(addDays(date1, randInt(15, 40))), amount, ref: txnRef, desc: `${vendorB} - unrelated payment ${txnRef}` });
  } else {
    const vendor = pick(VENDORS);
    const invRef = nextInvoiceRef();
    const txnRef = nextTxnRef();
    const amount2 = round2(amount * (1 + (rand() < 0.5 ? -1 : 1) * (0.08 + rand() * 0.15)));
    ledgerRows.push({ date: fmtDate(date1), amount, ref: invRef, desc: `${vendor} invoice ${invRef}` });
    bankRows.push({ date: fmtDate(addDays(date1, randInt(0, 2))), amount: amount2, ref: txnRef, desc: `${vendor} partial/adjusted payment ${txnRef}` });
  }
}

const N_EXACT = 100;
const N_FUZZY = 33;
const N_SPLIT = 20;   // each produces 2-3 ledger rows + 1 bank row
const N_UNRESOLVED = 11;
const N_DECOY = 16;

for (let i = 0; i < N_EXACT; i++) addExactMatch();
for (let i = 0; i < N_FUZZY; i++) addFuzzyMatch();
for (let i = 0; i < N_SPLIT; i++) addSplitMatch();
for (let i = 0; i < N_UNRESOLVED; i++) addUnresolved();
for (let i = 0; i < N_DECOY; i++) addNearMissDecoy();

// shuffle (Fisher-Yates, seeded)
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
shuffle(bankRows);
shuffle(ledgerRows);

function toCsv(rows, cols) {
  const header = cols.join(',');
  const lines = rows.map((r) =>
    cols.map((c) => {
      let v = r[c] === undefined ? '' : r[c];
      if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) {
        v = `"${v.replace(/"/g, '""')}"`;
      }
      return v;
    }).join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}

const bankCsv = toCsv(bankRows, ['date', 'amount', 'ref', 'desc']);
const ledgerCsv = toCsv(ledgerRows, ['date', 'amount', 'ref', 'desc']);

fs.writeFileSync(path.join(__dirname, 'bank_statement.csv'), bankCsv);
fs.writeFileSync(path.join(__dirname, 'ledger.csv'), ledgerCsv);

console.log(`Generated ${bankRows.length} bank rows and ${ledgerRows.length} ledger rows.`);
console.log(`  exact-match pairs targeted: ${N_EXACT}`);
console.log(`  fuzzy-match pairs targeted: ${N_FUZZY}`);
console.log(`  split/combo groups targeted: ${N_SPLIT}`);
console.log(`  unresolved singles targeted: ${N_UNRESOLVED}`);
console.log(`  near-miss decoys targeted: ${N_DECOY}`);
