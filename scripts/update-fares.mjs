import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'fares.json');
const GTFS_URL = 'https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip';
const FARES_PAGE = 'https://bus.gov.il/FaresDistance';
const USER_AGENT = 'Derech-Laavoda-Fare-Updater/1.0 (+https://hechzer-nesiot-il.netlify.app/)';
const TIMEOUT_MS = 25000;

function withTimeout(ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

async function fetchBuffer(url, init = {}) {
  const t = withTimeout();
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(init.headers || {}) },
      signal: t.signal
    });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  } finally {
    t.clear();
  }
}

function findEOCD(buf) {
  const sig = 0x06054b50;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

async function readCentralDirectory(url) {
  const tail = await fetchBuffer(url, { headers: { range: 'bytes=-131072' } });
  const cr = tail.res.headers.get('content-range');
  const fullLength = cr ? Number(cr.split('/')[1]) : Number(tail.res.headers.get('content-length') || tail.buf.length);
  const isFull = tail.res.status === 200 && tail.buf.length === fullLength;
  const tailStart = isFull ? 0 : fullLength - tail.buf.length;
  const eocdAt = findEOCD(tail.buf);
  if (eocdAt < 0) throw new Error('ZIP EOCD not found');

  const cdSize = tail.buf.readUInt32LE(eocdAt + 12);
  const cdOffset = tail.buf.readUInt32LE(eocdAt + 16);
  let cd;
  if (cdOffset >= tailStart && cdOffset + cdSize <= tailStart + tail.buf.length) {
    cd = tail.buf.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
  } else if (isFull) {
    cd = tail.buf.subarray(cdOffset, cdOffset + cdSize);
  } else {
    const part = await fetchBuffer(url, { headers: { range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` } });
    cd = part.buf;
  }

  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const compression = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, compression, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new Error('ZIP central directory empty');
  return { entries, fullLength };
}

async function readZipEntry(url, entry) {
  const header = await fetchBuffer(url, { headers: { range: `bytes=${entry.localOffset}-${entry.localOffset + 29}` } });
  if (header.buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
  const nameLen = header.buf.readUInt16LE(26);
  const extraLen = header.buf.readUInt16LE(28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize - 1;
  const data = await fetchBuffer(url, { headers: { range: `bytes=${start}-${end}` } });
  if (entry.compression === 0) return data.buf;
  if (entry.compression === 8) return inflateRawSync(data.buf);
  throw new Error(`Unsupported ZIP compression ${entry.compression} for ${entry.name}`);
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else {
      if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift().map(x => x.trim());
  return rows.filter(r => r.some(x => x !== '')).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function getCol(row, ...names) {
  for (const n of names) if (Object.prototype.hasOwnProperty.call(row, n)) return row[n];
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (lower[n.toLowerCase()] !== undefined) return lower[n.toLowerCase()];
  return '';
}

function nearestPrice(candidates, expected, maxDelta) {
  const valid = candidates.filter(x => Number.isFinite(x.price) && Math.abs(x.price - expected) <= maxDelta);
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const da = Math.abs(a.price - expected), db = Math.abs(b.price - expected);
    if (da !== db) return da - db;
    return (b.weight || 0) - (a.weight || 0);
  });
  return valid[0].price;
}

async function readOperationalSingleFares(existing) {
  const { entries } = await readCentralDirectory(GTFS_URL);
  const find = (name) => entries.find(e => e.name.toLowerCase().endsWith(name.toLowerCase()));
  const attrEntry = find('fare_attributes.txt');
  const rulesEntry = find('fare_rules.txt');
  if (!attrEntry || !rulesEntry) throw new Error('fare_attributes.txt / fare_rules.txt not found in official GTFS');

  const [attrBuf, rulesBuf] = await Promise.all([
    readZipEntry(GTFS_URL, attrEntry),
    readZipEntry(GTFS_URL, rulesEntry)
  ]);
  const attrs = parseCSV(attrBuf.toString('utf8'));
  const rules = parseCSV(rulesBuf.toString('utf8'));
  if (!attrs.length || !rules.length) throw new Error('Official GTFS fare tables are empty');

  const attrById = new Map();
  for (const r of attrs) {
    const id = String(getCol(r, 'fare_id', 'FareId')).trim();
    const price = Number(getCol(r, 'price', 'Price'));
    if (id && Number.isFinite(price) && price > 0) attrById.set(id, price);
  }

  const counts = new Map();
  for (const r of rules) {
    const id = String(getCol(r, 'fare_id', 'FareId')).trim();
    if (!id || !attrById.has(id)) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const byPrice = new Map();
  for (const [id, price] of attrById) {
    const weight = counts.get(id) || 0;
    if (price < 4 || price > 160 || weight <= 0) continue;
    const key = price.toFixed(2);
    const prev = byPrice.get(key) || { price, weight: 0 };
    prev.weight += weight;
    byPrice.set(key, prev);
  }
  const candidates = [...byPrice.values()];
  if (candidates.length < 4) throw new Error(`Not enough operational fare candidates (${candidates.length})`);

  // Conservative mapping: only move a band when the official operational GTFS has
  // a nearby fare candidate. This avoids accidentally taking a rail fare when the feed changes.
  const old = existing.singleRide.map(x => Number(x.price));
  const proposed = [
    nearestPrice(candidates, old[0], 4),
    nearestPrice(candidates, old[1], 5),
    nearestPrice(candidates, old[2], 6),
    nearestPrice(candidates, old[3], 6),
    nearestPrice(candidates, old[4], 8),
    nearestPrice(candidates, old[5], 25)
  ];
  if (proposed.some(v => v == null)) throw new Error(`Could not map all distance bands from GTFS: ${JSON.stringify(proposed)}`);
  if (!(proposed[0] <= proposed[1] && proposed[1] <= proposed[2] && proposed[2] <= proposed[3] && proposed[3] <= proposed[4] && proposed[4] < proposed[5])) {
    throw new Error(`GTFS fare mapping failed monotonicity check: ${JSON.stringify(proposed)}`);
  }

  return existing.singleRide.map((row, i) => ({ ...row, price: proposed[i] }));
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&lt;|&#60;/gi, '<')
    .replace(/&gt;|&#62;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function flattenHTML(html) {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u05([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(`05${h}`, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function numbersNear(text, regex, window = 700) {
  const m = regex.exec(text);
  if (!m) return [];
  const frag = text.slice(m.index, m.index + window);
  return [...frag.matchAll(/(?<!\d)(\d{1,4}(?:\.\d{1,2})?)(?!\d)/g)].map(x => Number(x[1])).filter(Number.isFinite);
}

async function readMonthlyFares(existing) {
  const t = withTimeout();
  try {
    const res = await fetch(FARES_PAGE, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' }, signal: t.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from fares page`);
    const raw = await res.text();
    const text = flattenHTML(raw + ' ' + decodeEntities(raw));

    const row015 = numbersNear(text, /0\s*[-–]\s*15/);
    const row225 = numbersNear(text, /225\s*(?:ומעלה|\+|ומעלה)/);
    const rowZone1 = numbersNear(text, /אזור\s*1/);

    const pickHundreds = arr => arr.filter(n => n >= 100 && n <= 1000);
    const nationalUp = pickHundreds(row015)[0];
    const nationalOver = pickHundreds(row225)[0];
    const zone1 = pickHundreds(rowZone1)[0];

    const next = { ...existing.monthly };
    if (Number.isFinite(nationalUp)) next.nationalUpTo225 = nationalUp;
    if (Number.isFinite(nationalOver)) next.nationalOver225 = nationalOver;
    if (Number.isFinite(zone1)) next.zone1 = zone1;

    if (!(next.nationalUpTo225 >= 100 && next.nationalUpTo225 <= 1000)) throw new Error('Invalid national monthly fare');
    if (!(next.nationalOver225 >= next.nationalUpTo225 && next.nationalOver225 <= 1200)) throw new Error('Invalid over-225 monthly fare');
    if (!(next.zone1 >= 50 && next.zone1 <= next.nationalUpTo225)) throw new Error('Invalid Zone 1 monthly fare');
    return next;
  } finally {
    t.clear();
  }
}

function stableRateShape(x) {
  return JSON.stringify({ vat: x.vat, singleRide: x.singleRide, monthly: x.monthly });
}

async function main() {
  const current = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  const next = structuredClone(current);
  const diagnostics = [];

  try {
    next.singleRide = await readOperationalSingleFares(current);
    diagnostics.push('GTFS single-ride fares: OK');
  } catch (err) {
    diagnostics.push(`GTFS single-ride fares: FAILED — ${err.message}`);
  }

  try {
    next.monthly = await readMonthlyFares(current);
    diagnostics.push('Official monthly fares page: OK');
  } catch (err) {
    diagnostics.push(`Official monthly fares page: FAILED — ${err.message}`);
  }

  console.log(diagnostics.join('\n'));

  if (diagnostics.every(x => x.includes('FAILED'))) {
    throw new Error('All official fare sources failed; keeping last verified fares');
  }

  if (stableRateShape(next) === stableRateShape(current)) {
    console.log('No fare changes detected. Nothing to write.');
    return;
  }

  next.updatedAt = new Date().toISOString();
  await fs.writeFile(DATA_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log('Fare changes detected and data/fares.json was updated.');
  console.log(JSON.stringify({ singleRide: next.singleRide, monthly: next.monthly }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
