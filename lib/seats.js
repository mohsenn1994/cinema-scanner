// Turns a parsed seat map { rows: [[{l,s,c,a}|null]], areas, screenAtTop? } into counts + a suggested block.
function screenIsAtTop(map) {
  if (typeof map.screenAtTop === 'boolean') return map.screenAtTop;
  const rows = map.rows;
  const letterOf = (r) => ((r || []).find((x) => x && x.l) || { l: '' }).l.split('-')[0];
  if (letterOf(rows[0]) === 'A') return true;
  if (letterOf(rows[rows.length - 1]) === 'A') return false;
  // Premium/VIP rows sit furthest from the screen.
  const vipIdx = rows.map((r, i) => (r.some((x) => x && /vip|premium/.test(x.c)) ? i : -1)).filter((i) => i >= 0);
  return vipIdx.length ? vipIdx.reduce((a, b) => a + b, 0) / vipIdx.length >= (rows.length - 1) / 2 : true;
}

function analyseSeats(map, partySize = 2) {
  if (!map || !map.rows || !map.rows.length) return null;
  const rows = map.rows;
  const width = Math.max(...rows.map((r) => r.length));
  const screenAtTop = screenIsAtTop(map);

  const counts = {};
  let total = 0;
  let available = 0;
  const cols = [];
  rows.forEach((r) =>
    r.forEach((x, ci) => {
      if (!x) return;
      cols.push(ci);
      const k = x.c;
      counts[k] = counts[k] || { available: 0, total: 0 };
      counts[k].total++;
      total++;
      if (x.s) {
        counts[k].available++;
        available++;
      }
    })
  );
  const center = cols.length ? cols.reduce((a, b) => a + b, 0) / cols.length : width / 2;

  // Best block of `partySize` adjacent free seats: near the centre line, ~2/3 of the way back.
  let best = null;
  rows.forEach((r, ri) => {
    const depth = rows.length > 1 ? (screenAtTop ? ri : rows.length - 1 - ri) / (rows.length - 1) : 0.5;
    for (let ci = 0; ci + partySize <= r.length; ci++) {
      const block = r.slice(ci, ci + partySize);
      if (block.some((x) => !x || !x.s)) continue;
      const mid = ci + (partySize - 1) / 2;
      const score = Math.abs(mid - center) / Math.max(width, 1) + 1.2 * Math.abs(depth - 0.65);
      if (!best || score < best.score) best = { score, seats: block.map((x) => x.l) };
    }
  });

  for (const [area, info] of Object.entries(map.areas || {})) {
    const cat = Object.keys(counts).find((k) => rows.some((r) => r.some((x) => x && x.c === k && x.a === area)));
    if (cat) Object.assign(counts[cat], info);
  }
  return { total, available, counts, best, screenAtTop };
}

module.exports = { analyseSeats };
