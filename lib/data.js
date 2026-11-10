// Builds the public data.json that the web UI reads (locally or from GitHub).
const path = require('path');
const { DIR, CHAINS, CHAIN_LABELS, loadCatalog, readJson, writeJson } = require('./config');
const { analyseSeats } = require('./seats');
const { parseTime, nameMatches, squash } = require('./util');

const STATE_DIR = path.join(DIR, 'state');
const QUICK = path.join(STATE_DIR, 'quick.json');
const SEATS = path.join(STATE_DIR, 'seats.json');
const DATA = path.join(DIR, 'data.json');

// Seat map → rows of one character per cell, screen always at the top:
//  ' ' gap · '1' free · '0' taken · 'v' premium free · 'w' premium taken
function encodeSeats(map, partySize) {
  const a = analyseSeats(map, partySize);
  if (!a) return null;
  const rows = (a.screenAtTop ? map.rows : [...map.rows].reverse()).map((r) => {
    const first = r.find((x) => x && x.l);
    return {
      r: first ? first.l.split('-')[0] : '',
      c: r.map((x) => (!x ? ' ' : /vip|premium/.test(x.c) ? (x.s ? 'v' : 'w') : x.s ? '1' : '0')).join(''),
      n: r.filter(Boolean).map((x) => x.l.split('-').pop()).join(','),
    };
  });
  const cats = Object.entries(a.counts).map(([k, v]) => ({ n: v.label || (k === 'vip' ? 'Premium / VIP' : k === 'standard' ? 'Regular' : k), f: v.available, t: v.total, p: (v.price || '').replace(' per ticket', '') }));
  return { free: a.available, total: a.total, cats, rows };
}

// prevData: last published data — used for seat maps when this machine has none (e.g. the GitHub backup).
function buildData(cfg, extra = {}, prevData = null) {
  const quick = readJson(QUICK, { shows: [], sources: {} });
  const seats = readJson(SEATS, { seats: {}, premiereUrls: {} });
  const catalog = loadCatalog();
  const movies = cfg.movies.filter((m) => m.enabled !== false);

  const cinemaIdx = new Map();
  const cinemas = [];
  const cinemaId = (chain, name) => {
    const k = `${chain}|${name}`;
    if (!cinemaIdx.has(k)) {
      cinemaIdx.set(k, cinemas.length);
      cinemas.push({ chain, chainLabel: CHAIN_LABELS[chain], name, seats: cfg.cinemas.some((c) => c.enabled !== false && c.chain === chain && nameMatches(name, c.name)) });
    }
    return cinemaIdx.get(k);
  };
  // List every known cinema so viewers can pick ones with nothing on yet.
  for (const chain of CHAINS) {
    const cat = (catalog.chains || {})[chain] || {};
    const names = chain === 'scene' ? (cat.sites || []).map((s) => s.name) : cat.cinemas || [];
    names.forEach((n) => cinemaId(chain, n));
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const lastDay = cfg.days > 0 ? new Date(Date.parse(today) + cfg.days * 86400000).toISOString().slice(0, 10) : '9999';
  const prevSeat = new Map(((prevData && prevData.shows) || []).filter((x) => x.seat).map((x) => [x.u, x.seat]));
  const shows = [];
  const screens = new Set();
  for (const s of quick.shows) {
    const mi = movies.findIndex((m) => m.name === s.movie);
    if (mi < 0 || !s.iso || s.iso < today || s.iso >= lastDay) continue;
    const t = parseTime(s.time);
    const seat = seats.seats[s.uid];
    const url = s.chain === 'premiere' ? seats.premiereUrls[s.uid] || s.bookUrl : s.bookUrl;
    screens.add(s.screen);
    shows.push({
      u: s.uid,
      m: mi,
      c: cinemaId(s.chain, s.cinema),
      d: s.iso,
      t: t.label,
      k: t.sort,
      s: s.screen,
      f: s.format || '2D',
      b: s.bookable ? 1 : 0,
      url,
      direct: s.chain !== 'premiere' || url.includes('/seats/') ? 1 : 0,
      seat: seat && seat.map ? { at: seat.at, ...encodeSeats(seat.map, cfg.partySize) } : prevSeat.get(s.uid),
    });
  }
  shows.sort((a, b) => a.d.localeCompare(b.d) || a.k - b.k);

  const tracked = new Set(movies.map((m) => squash(m.name)));
  const comingSoon = [];
  for (const chain of CHAINS) {
    for (const m of ((catalog.chains || {})[chain] || {}).comingSoon || []) {
      if (tracked.has(squash(m.title))) continue;
      const hit = comingSoon.find((x) => squash(x.title) === squash(m.title));
      if (hit) hit.chains.includes(chain) || hit.chains.push(chain);
      else comingSoon.push({ title: m.title, chains: [chain] });
    }
  }

  const data = {
    v: 1,
    generatedAt: new Date().toISOString(),
    quickAt: quick.at || null,
    seatsAt: seats.at || null,
    partySize: cfg.partySize,
    movies: movies.map((m, i) => {
      const mine = shows.filter((s) => s.m === i);
      const links = {};
      for (const chain of CHAINS) if (quick.sources && quick.sources[`${chain}|${m.name}`] && quick.sources[`${chain}|${m.name}`].url) links[chain] = quick.sources[`${chain}|${m.name}`].url;
      return { name: m.name, status: mine.some((s) => s.b) ? 'on-sale' : mine.length ? 'listed' : 'coming-soon', links, chains: CHAINS.filter((c) => m[c]) };
    }),
    cinemas,
    screens: [...screens].sort(),
    shows,
    comingSoon,
    alerts: cfg.ntfy && cfg.ntfy.enabled && cfg.ntfy.topic ? { server: cfg.ntfy.server, topic: cfg.ntfy.topic } : null,
    dispatch: cfg.dispatchUrl || null,
    trigger: cfg.trigger && cfg.trigger.topic ? { server: cfg.trigger.server, topic: cfg.trigger.topic } : null,
    repo: cfg.github && cfg.github.owner ? `https://github.com/${cfg.github.owner}/${cfg.github.repo}` : null,
    ...extra,
  };
  writeJson(DATA, data);
  return data;
}

module.exports = { encodeSeats, buildData, STATE_DIR, QUICK, SEATS, DATA };
