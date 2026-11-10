const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "Wed 16 Dec" (+ optional VOX ?d=YYYYMMDD href) → "2026-12-16"
function labelToIso(label, href) {
  const m = href && href.match(/[?&]d=(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const p = String(label).match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!p) return null;
  const now = new Date();
  const mon = MONTHS[p[2].toLowerCase()];
  let year = now.getFullYear();
  if (mon < now.getMonth() - 1) year += 1; // "3 Jan" seen in December
  return `${year}-${String(mon + 1).padStart(2, '0')}-${String(p[1]).padStart(2, '0')}`;
}

function isoLabel(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

// "2:45pm" / "02:45 PM" → { label: "2:45 PM", sort: minutes, after-midnight shows sort last }
function parseTime(t) {
  const m = String(t).trim().match(/(\d{1,2}):(\d{2})\s*([ap])\.?m?/i);
  if (!m) return { label: String(t).trim(), sort: 9999 };
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  let mins = h * 60 + Number(m[2]);
  if (mins < 6 * 60) mins += 24 * 60; // 12:30 AM belongs to the end of the cinema day
  return { label: `${Number(m[1])}:${m[2]} ${m[3].toUpperCase()}M`, sort: mins };
}

const isAll = (arr) => !arr || arr.length === 0 || arr.some((x) => norm(x) === 'all' || x === '*');
// "Premiere Point 90" matches "Premiere Point90"; "Almaza" matches "City Centre Almaza".
const squash = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const nameMatches = (name, wanted) => {
  const a = squash(name);
  const b = squash(wanted);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};

// "MAX 3D" → { screen: "MAX", format: "3D" };  "Standard & Deluxe" → { screen: "Standard & Deluxe", format: "2D" }
function splitScreen(name, format) {
  const raw = String(name || '').trim();
  const f = format || (/\b3d\b/i.test(raw) ? '3D' : '2D');
  const screen = raw.replace(/\s*\b[23]d\b\s*/gi, ' ').replace(/\s+/g, ' ').trim() || 'Standard';
  return { screen, format: String(f).toUpperCase() };
}

module.exports = { splitScreen, squash, norm, sleep, log, labelToIso, isoLabel, addDays, parseTime, isAll, nameMatches };
