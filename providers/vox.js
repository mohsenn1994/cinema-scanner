// VOX Cinemas Egypt — server-rendered showtimes; seat map after "Continue as Guest".
const { labelToIso, nameMatches, sleep, splitScreen } = require('../lib/util');

const SITE = 'https://egy.voxcinemas.com';

function parseShowtimesInPage() {
  const sec = document.querySelector('#showtimes');
  if (!sec) {
    // A real movie page always has a title and the booking section; a bot-check page has neither.
    const realPage = !!document.querySelector('h1') && /vox/i.test(document.title);
    return { title: document.title, dates: [], cinemas: [], blocked: !realPage || /access denied|request unsuccessful|incident id/i.test(document.body.innerText) };
  }
  const dates = [...sec.querySelectorAll('nav.date-filter li')].map((li) => {
    const a = li.querySelector('a');
    return { label: li.textContent.trim().replace(/\s+/g, ' '), href: a ? a.href : null, current: !a };
  });
  const cinemas = [];
  for (const h3 of sec.querySelectorAll('.dates h3')) {
    const experiences = [];
    let el = h3.nextElementSibling;
    while (el && el.tagName !== 'H3') {
      if (el.matches('ol.showtimes')) {
        for (const li of el.children) {
          const exp = li.querySelector(':scope > strong');
          const times = [...li.querySelectorAll(':scope > ol > li')].map((t) => {
            const a = t.querySelector('a.showtime');
            const s = t.querySelector('.showtime');
            return { id: t.dataset.id || (a && a.dataset.id) || null, time: (s ? s.textContent : t.textContent).trim(), bookable: !!a };
          });
          experiences.push({ experience: exp ? exp.textContent.trim() : 'Standard', times });
        }
      }
      el = el.nextElementSibling;
    }
    cinemas.push({ cinema: h3.textContent.trim(), experiences });
  }
  const h1 = document.querySelector('h1');
  return { title: (h1 ? h1.textContent : document.title).trim(), dates, cinemas };
}

function parseSeatsInPage() {
  const plan = document.querySelector('.seating-plan');
  if (!plan) return null;
  const areas = {};
  plan.querySelectorAll('ul.key li[data-area]').forEach((li) => {
    areas[li.dataset.area] = { label: li.dataset.label || '', price: li.dataset.price || '' };
  });
  const SKIP = new Set(['seat', 'normal', 'sold', 'blank', 'allocated']);
  const rows = [...plan.querySelectorAll('table tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => {
      if (td.classList.contains('blank')) return null;
      const inp = td.querySelector('input');
      const label = (inp && inp.dataset.label) || (td.querySelector('label') || {}).title || '';
      const sold = td.classList.contains('sold') || !inp || inp.disabled;
      const cat = [...td.classList].find((c) => !SKIP.has(c) && !c.startsWith('sub-category')) || 'other';
      return { l: label, s: sold ? 0 : 1, c: cat, a: td.dataset.area || '' };
    })
  );
  return { areas, rows };
}

const finish = (o) => ({ ...o, cinemasSeen: [...o.cinemasSeen], screensSeen: [...o.experiencesSeen].map((e) => splitScreen(e).screen) });
const movieUrl = (ref) => (/^https?:/.test(ref) ? ref.split(/[?#]/)[0] : `${SITE}/movies/${ref}`);

async function load(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#showtimes', { timeout: 30000 }).catch(() => {});
  const data = await page.evaluate(parseShowtimesInPage);
  if (data.blocked) throw new Error(`VOX blocked the request (page "${String(data.title).slice(0, 60)}")`);
  return data;
}

module.exports = {
  chain: 'vox',
  label: 'VOX',
  movieUrl,

  async collect(page, { ref, cinemas, delay }) {
    const base = movieUrl(ref);
    const first = await load(page, base);
    const out = { title: first.title, url: base, cinemasSeen: new Set(), experiencesSeen: new Set(), showtimes: [] };
    if (!first.dates.length && !first.cinemas.length) return finish(out); // listed but no showtimes yet (coming soon)
    for (const d of first.dates.length ? first.dates : [{ label: '', current: true }]) {
      let data = first;
      if (!d.current) {
        await sleep(delay);
        data = await load(page, d.href);
      }
      const iso = labelToIso(d.label, d.href);
      for (const c of data.cinemas) {
        out.cinemasSeen.add(c.cinema);
        c.experiences.forEach((e) => out.experiencesSeen.add(e.experience));
        if (cinemas && !cinemas.some((w) => nameMatches(c.cinema, w))) continue;
        for (const e of c.experiences)
          for (const t of e.times)
            out.showtimes.push({
              uid: `vox:${t.id}`,
              cinema: c.cinema,
              iso,
              ...splitScreen(e.experience),
              time: t.time,
              bookable: t.bookable && !!t.id,
              bookUrl: t.id ? `${SITE}/booking/${t.id}` : base,
              seatRef: t.id,
            });
      }
    }
    return finish(out);
  },

  async seatMap(page, s) {
    await page.goto(`${SITE}/booking/${s.seatRef}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (!(await page.$('.seating-plan table td'))) {
      const guest = await page.$('a[href*="/seats/fetch"]'); // not logged in → "Continue as Guest"
      if (guest) await page.goto(new URL(await guest.getAttribute('href'), SITE).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForSelector('.seating-plan table td', { timeout: 45000 });
    return page.evaluate(parseSeatsInPage);
  },

  async discover(page) {
    const movies = new Map();
    const comingSoon = new Map();
    for (const p of ['/movies/whatson', '/movies/comingsoon']) {
      await page.goto(SITE + p, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      const found = await page
        .evaluate(() =>
          [...document.querySelectorAll('a[href^="/movies/"] img.poster')].map((img) => ({
            id: img.closest('a').getAttribute('href').split(/[?#]/)[0].replace('/movies/', ''),
            title: (img.alt || '').replace(/^Movie poster for\s*/i, '').trim(),
          }))
        )
        .catch(() => []);
      const into = p.endsWith('comingsoon') ? comingSoon : movies;
      found.forEach((m) => m.id && !into.has(m.id) && into.set(m.id, m));
    }
    // VOX movie pages exist for coming-soon titles too, so they can be watched for booking opening.
    return { movies: [...movies.values()], comingSoon: [...comingSoon.values()].filter((m) => !movies.has(m.id)) };
  },

  parseShowtimesInPage,
  parseSeatsInPage,
};
