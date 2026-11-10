// Premiere Cinemas — Next.js app with encrypted APIs, so we click through its UI.
// Quick pass: read each cinema's date list (cheap), then fetch times for new dates first and refresh the
// stalest ones within a time budget. Seat pages are only revealed by clicking, so they're located in the
// seats pass and remembered.
const { labelToIso, nameMatches } = require('../lib/util');
const { premiereTask, premiereSeats } = require('./premiere-page');

const SITE = 'https://www.premiere-cinemas.com';
const idOf = (ref) => {
  const m = String(ref).match(/movie-details\/([\d.]+)/);
  return m ? m[1] : String(ref);
};
const movieUrl = (ref) => `${SITE}/en/movie-details/${idOf(ref)}/1`;
const keyOf = (s) => [s.cinema, s.date, s.experience || '', s.format || '', s.time].join('|');

module.exports = {
  chain: 'premiere',
  label: 'Premiere',
  movieUrl,

  // known: { "cinema|date": { at, shows: [...] } } from earlier quick passes (mutated and returned).
  async collect(page, { ref, cinemas, known = {}, budgetMs = 45000, refreshMinutes = 20 }) {
    const id = idOf(ref);
    const url = movieUrl(ref);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const names = cinemas ? cinemas.map((c) => c.name || c) : [];
    const d = await page.evaluate(premiereTask, { type: 'dates', cinemas: names });

    const current = [];
    for (const [cinema, dates] of Object.entries(d.dates)) for (const date of dates) current.push(`${cinema}|${date}`);
    const live = new Set(current);
    for (const k of Object.keys(known)) if (!live.has(k)) delete known[k]; // date passed or pulled

    const fresh = (k) => known[k] && Date.now() - known[k].at < refreshMinutes * 60000;
    const targets = current
      .filter((k) => !fresh(k))
      .sort((a, b) => (known[a] ? known[a].at : 0) - (known[b] ? known[b].at : 0)) // new (never seen) first, then stalest
      .map((k) => ({ cinema: k.split('|')[0], date: k.split('|')[1] }));

    if (targets.length) {
      const r = await page.evaluate(premiereTask, { type: 'drill', cinemas: names, targets, budgetMs });
      for (const k of r.done) known[k] = { at: Date.now(), shows: [] };
      for (const s of r.showtimes) known[`${s.cinema}|${s.date}`].shows.push(s);
    }

    const showtimes = [];
    const screens = new Set();
    for (const k of current) {
      if (!known[k]) {
        // Listed date we haven't opened yet: still worth showing as "listed".
        continue;
      }
      for (const s of known[k].shows) {
        const screen = s.experience || 'Standard';
        screens.add(screen);
        showtimes.push({
          uid: `premiere:${id}|${keyOf(s)}`,
          key: keyOf(s),
          cinema: s.cinema,
          iso: labelToIso(s.date),
          screen,
          format: s.format || '2D',
          time: s.time,
          bookable: s.bookable,
          bookUrl: url,
          seatRef: null,
          pick: { cinema: s.cinema, date: s.date, format: s.format, experience: s.experience, time: s.time },
        });
      }
    }
    return { title: d.title, url, cinemasSeen: d.cinemas, screensSeen: [...screens], showtimes, known, dates: current, pending: current.filter((k) => !known[k]).length };
  },

  // Seats pass: click through to find seat-selection URLs for showtimes we don't have yet.
  async locateSeatPages(page, { ref, targets, budgetMs = 120000 }) {
    if (!targets.length) return {};
    await page.goto(movieUrl(ref), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const r = await page.evaluate(premiereTask, { type: 'capture', targets: targets.map((t) => ({ ...t.pick, key: t.key })), budgetMs });
    return r.urls;
  },

  async seatMap(page, s) {
    if (!s.seatRef) throw new Error('seat page not located yet');
    await page.goto(s.seatRef, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.seat-layout-container table img', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(1500);
    return page.evaluate(premiereSeats);
  },

  async discover(page) {
    await page.goto(`${SITE}/en`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('a[href*="movie-details/"]', { timeout: 20000 }).catch(() => {});
    const movies = await page
      .evaluate(() => {
        const seen = new Map();
        for (const a of document.querySelectorAll('a[href*="movie-details/"]')) {
          const m = a.getAttribute('href').match(/(coming-soon-)?movie-details\/([\d.]+)/);
          if (!m || seen.has(m[2])) continue;
          let p = a;
          for (let i = 0; i < 5 && p.innerText.trim().split('\n').filter(Boolean).length < 2; i++) p = p.parentElement;
          const parts = p.innerText.split('\n').map((x) => x.trim()).filter((x) => x && !/^(pre-?book|book now)$/i.test(x));
          seen.set(m[2], { id: m[2], title: parts[0] || m[2], comingSoon: !!m[1] });
        }
        return [...seen.values()];
      })
      .catch(() => []);
    // Coming-soon ids differ from bookable ids, so only bookable ones can be scanned.
    return { movies: movies.filter((m) => !m.comingSoon), comingSoon: movies.filter((m) => m.comingSoon) };
  },
  nameMatches,
};
