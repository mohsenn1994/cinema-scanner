// Scene Cinemas — one subdomain per branch (cfc, district5, …).
const { nameMatches, splitScreen } = require('../lib/util');
const { sceneCollect, sceneSeats } = require('./scene-page');

const siteUrl = (site) => `https://${site}.scenecinemas.com`;
const slugOf = (ref) => String(ref).replace(/^https?:\/\/[^/]+/, '').replace(/^\/?movie-details\//, '').replace(/\.html.*$/, '');

module.exports = {
  chain: 'scene',
  label: 'Scene',
  movieUrl: (ref, site = 'cfc') => `${siteUrl(site)}/movie-details/${slugOf(ref)}.html`,

  // cinemas: [{ name, site }]
  // sites: [{ site, name }] — every Scene branch to read
  async collect(page, { ref, sites }) {
    const out = { title: '', url: '', cinemasSeen: new Set(), experiencesSeen: new Set(), showtimes: [], errors: [] };
    for (const c of sites) {
      const url = `${siteUrl(c.site)}/movie-details/${slugOf(ref)}.html`;
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (res && res.status() >= 400) continue; // movie not showing at this branch
        const r = await page.evaluate(sceneCollect, { days: 60 });
        out.title = out.title || r.title;
        out.url = out.url || url;
        for (const s of r.showtimes) {
          out.cinemasSeen.add(s.cinema || c.name);
          out.experiencesSeen.add(splitScreen(s.experience).screen);
          out.showtimes.push({
            uid: `scene:${c.site}:${s.id || s.iso + s.time}`,
            cinema: s.cinema || c.name,
            iso: s.iso,
            ...splitScreen(s.experience),
            time: s.time,
            bookable: s.bookable,
            bookUrl: s.url || url,
            seatRef: s.url,
          });
        }
      } catch (e) {
        out.errors.push(`${c.name}: ${String(e.message || e).split('\n')[0]}`);
      }
    }
    return { ...out, cinemasSeen: [...out.cinemasSeen], screensSeen: [...out.experiencesSeen] };
  },

  async seatMap(page, s) {
    await page.goto(s.seatRef, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The seat plan arrives by AJAX and fills app-type attributes on the grid.
    await page.waitForSelector('#reservation-app-hall [app-type]', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(800);
    return page.evaluate(sceneSeats);
  },

  async discover(page, { sites }) {
    const movies = new Map();
    const foundSites = new Map(sites.map((s) => [s.site, s.name]));
    for (const site of [...foundSites.keys()]) {
      await page.goto(`${siteUrl(site)}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      const r = await page
        .evaluate(() => ({
          movies: [...document.querySelectorAll('a[href*="/movie-details/"]')]
            .map((a) => ({ href: a.href, title: (a.getAttribute('title') || '').trim() }))
            .filter((m) => m.title),
          sites: [...document.querySelectorAll('a[href*=".scenecinemas.com"]')]
            .map((a) => ({ m: a.href.match(/^https:\/\/([a-z0-9-]+)\.scenecinemas\.com\/?$/), name: a.textContent.trim().split('\n')[0].trim() }))
            .filter((x) => x.m && x.name)
            .map((x) => ({ site: x.m[1], name: x.name })),
        }))
        .catch(() => ({ movies: [], sites: [] }));
      r.movies.forEach((m) => {
        const id = m.href.split('/movie-details/')[1].replace(/\.html.*$/, '');
        if (!movies.has(id)) movies.set(id, { id, title: m.title });
      });
      r.sites.forEach((s) => s.site !== 'www' && !foundSites.has(s.site) && foundSites.set(s.site, s.name));
    }
    return { movies: [...movies.values()], sites: [...foundSites].map(([site, name]) => ({ site, name })) };
  },
};
