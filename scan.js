#!/usr/bin/env node
/*
 * Cinema seat scanner — VOX, Scene and Premiere (Egypt).
 *
 *   node scan.js --quick      showtimes for every cinema (runs every 2 min): spots tickets going on sale
 *   node scan.js --seats      seat maps for your seat-map cinemas (runs every 10 min, and right after a sale opens)
 *   node scan.js              both
 *   node scan.js --discover   refresh the movie / cinema lists the settings page offers
 *   node scan.js --headed     show the browser
 *   node scan.js login [vox|scene|premiere]   sign in once; the seats pass reuses the session
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { chromium } = require('playwright');
const { DIR, CHAINS, loadConfig, saveConfig, loadCatalog, mergeCatalog, readJson, writeJson } = require('./lib/config');
const { norm, squash, sleep, log, nameMatches } = require('./lib/util');
const { buildData, STATE_DIR, QUICK, SEATS } = require('./lib/data');
const { sendAlerts } = require('./lib/alerts');
const { publishData, publishSite } = require('./lib/publish');
const { renderUi } = require('./lib/ui');

const PROVIDERS = { vox: require('./providers/vox'), scene: require('./providers/scene'), premiere: require('./providers/premiere') };
const LOGIN_URLS = { vox: 'https://egy.voxcinemas.com/', scene: 'https://cfc.scenecinemas.com/', premiere: 'https://www.premiere-cinemas.com/en' };
const DEFAULT_SCENE_SITES = [
  { site: 'cfc', name: 'Cairo Festival City' },
  { site: 'district5', name: 'District 5' },
];
const REPORT = path.join(DIR, 'report.html');
const STATUS = path.join(DIR, '.scan-status.json');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const MODE = flag('--quick') ? 'quick' : flag('--seats') ? 'seats' : flag('--discover') ? 'discover' : 'both';
fs.mkdirSync(STATE_DIR, { recursive: true });

// Separate browser profiles so the quick and seats passes can run at the same time.
async function launch(profile, headless) {
  const dir = path.join(DIR, profile);
  const opts = { headless, viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'Africa/Cairo' };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dir, { ...opts, channel: 'chrome' }); // real Chrome passes bot checks better
  } catch {
    ctx = await chromium.launchPersistentContext(dir, opts);
  }
  if (process.env.VOX_TEST_ROUTES) await require(process.env.VOX_TEST_ROUTES)(ctx); // offline tests only
  return ctx;
}

function lock(name) {
  const f = path.join(DIR, `.${name}.lock`);
  if (fs.existsSync(f)) {
    const pid = Number(fs.readFileSync(f, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && Date.now() - fs.statSync(f).mtimeMs < 30 * 60000) return null;
  }
  fs.writeFileSync(f, String(process.pid));
  return () => fs.rmSync(f, { force: true });
}

function status(patch) {
  const s = { ...readJson(STATUS, {}), ...patch, at: new Date().toISOString() };
  try {
    writeJson(STATUS, s);
  } catch {}
}

const isPriority = (cfg, screen) => cfg.priorityScreens.some((p) => norm(screen).includes(norm(p)));
const isExcluded = (cfg, screen) => cfg.excludedScreens.some((p) => norm(p) === norm(screen));
const seatCinema = (cfg, s) => cfg.cinemas.some((c) => c.enabled !== false && c.chain === s.chain && nameMatches(s.cinema, c.name));
const siteUrl = (cfg) => (cfg.github && cfg.github.enabled && cfg.github.owner ? `https://${cfg.github.owner}.github.io/${cfg.github.repo}/` : null);

// ---------- discovery ----------
async function discover(ctx, cfg) {
  const update = { discoveredAt: new Date().toISOString(), chains: {} };
  const page = await ctx.newPage();
  const cat = loadCatalog();
  for (const chain of CHAINS) {
    try {
      const sites = (((cat.chains || {}).scene || {}).sites || []).concat(cfg.cinemas.filter((c) => c.chain === 'scene' && c.site));
      const r = await PROVIDERS[chain].discover(page, { sites: sites.length ? sites : DEFAULT_SCENE_SITES });
      update.chains[chain] = { movies: r.movies, comingSoon: r.comingSoon || [], sites: r.sites || [] };
      log('discover', chain, `${r.movies.length} movies, ${(r.comingSoon || []).length} coming soon`);
    } catch (e) {
      log('discover failed', chain, e.message);
    }
  }
  await page.close();
  return mergeCatalog(update);
}

// Fill in a movie's page at a chain once that chain lists the same title (e.g. booking opened there).
function autoMatch(cfg, cat) {
  let changed = false;
  for (const m of cfg.movies) {
    for (const chain of CHAINS) {
      if (m[chain]) continue;
      const c = (cat.chains || {})[chain] || {};
      const list = (c.movies || []).concat(chain === 'vox' ? c.comingSoon || [] : []);
      const hit = list.find((x) => squash(x.title) === squash(m.name));
      if (hit) {
        m[chain] = hit.id;
        changed = true;
        log('matched', m.name, 'at', chain, hit.id);
      }
    }
  }
  if (changed) saveConfig(cfg);
}

// ---------- quick pass: showtimes everywhere ----------
async function quickPass(cfg) {
  const release = lock('quick');
  if (!release) return log('quick pass already running');
  const prev = readJson(QUICK, null);
  // premiereKnown is updated in place, so remember what was known before this run for the alert check.
  const prevKnown = JSON.parse(JSON.stringify((prev && prev.premiereKnown) || {}));
  const next = { at: null, shows: [], sources: {}, premiereKnown: (prev && prev.premiereKnown) || {}, premiereDates: {} };
  let ctx;
  try {
    status({ quick: { running: true, step: 'starting', pid: process.pid } });
    ctx = await launch('.browser-profile-quick', cfg.headless);
    let cat = loadCatalog();
    if (!cat.updatedAt || Date.now() - Date.parse(cat.updatedAt) > 3 * 3600000) cat = await discover(ctx, cfg);
    autoMatch(cfg, cat);

    const movies = cfg.movies.filter((m) => m.enabled !== false);
    const sceneSites = [...new Map([...DEFAULT_SCENE_SITES, ...(((cat.chains || {}).scene || {}).sites || []), ...cfg.cinemas.filter((c) => c.chain === 'scene' && c.site)].map((s) => [s.site, { site: s.site, name: s.name }])).values()];
    const seen = {};

    await Promise.all(
      CHAINS.map(async (chain) => {
        const provider = PROVIDERS[chain];
        const page = await ctx.newPage();
        seen[chain] = { cinemas: new Set(), screens: new Set() };
        for (const m of movies.filter((x) => x[chain])) {
          const key = `${chain}|${m.name}`;
          status({ quick: { running: true, step: `${provider.label}: ${m.name}`, pid: process.pid } });
          try {
            let out;
            if (chain === 'vox') out = await provider.collect(page, { ref: m.vox, cinemas: null, delay: Math.min(cfg.delayBetweenRequestsMs, 1000) });
            if (chain === 'scene') out = await provider.collect(page, { ref: m.scene, sites: sceneSites });
            if (chain === 'premiere') {
              const known = (next.premiereKnown[m.premiere] = next.premiereKnown[m.premiere] || {});
              out = await provider.collect(page, { ref: m.premiere, cinemas: null, known, refreshMinutes: cfg.premiereRefreshMinutes });
              next.premiereDates[m.premiere] = out.dates;
            }
            out.cinemasSeen.forEach((c) => seen[chain].cinemas.add(c));
            out.screensSeen.forEach((c) => seen[chain].screens.add(c));
            next.sources[key] = { url: out.url, title: out.title, ok: true };
            for (const s of out.showtimes) next.shows.push({ ...s, chain, movie: m.name });
          } catch (e) {
            const msg = String(e.message || e).split('\n')[0];
            log(chain, 'failed', m.name, msg);
            next.sources[key] = { ...((prev && prev.sources[key]) || {}), ok: false, error: msg };
            // Keep the last known showtimes so a hiccup doesn't look like "sold out" then "on sale" again.
            if (prev) for (const s of prev.shows) if (s.chain === chain && s.movie === m.name) next.shows.push(s);
            if (chain === 'premiere' && prev && prev.premiereDates) next.premiereDates[m.premiere] = prev.premiereDates[m.premiere];
          }
        }
        await page.close().catch(() => {});
      })
    );
    mergeCatalog({ chains: Object.fromEntries(Object.entries(seen).map(([c, v]) => [c, { cinemas: [...v.cinemas], screens: [...v.screens] }])) });
    next.at = new Date().toISOString();
    writeJson(QUICK, next);

    // What just went on sale?
    let newly = [];
    const opened = [];
    if (prev) {
      const before = new Set(prev.shows.filter((s) => s.bookable).map((s) => s.uid));
      const premiereRef = (name) => (movies.find((m) => m.name === name) || {}).premiere;
      newly = next.shows.filter((s) => {
        if (!s.bookable || before.has(s.uid)) return false;
        if (!prev.sources[`${s.chain}|${s.movie}`]) return false; // movie/chain just added to the scan: nothing "new" yet
        if (s.chain === 'premiere') {
          // Premiere times are read a few cinema-days per run. Only alert for days we'd already read
          // (a new time appeared) or days that weren't listed before (a new date opened).
          const id = premiereRef(s.movie);
          const k = s.key.split('|').slice(0, 2).join('|');
          const wasRead = prevKnown[id] && prevKnown[id][k];
          const wasListed = ((prev.premiereDates || {})[id] || []).includes(k);
          if (!wasRead && wasListed) return false;
        }
        return true;
      });
      for (const m of movies)
        for (const chain of CHAINS) {
          const had = prev.shows.some((s) => s.chain === chain && s.movie === m.name && s.bookable);
          const has = next.shows.some((s) => s.chain === chain && s.movie === m.name && s.bookable);
          if (!had && has && prev.sources[`${chain}|${m.name}`]) opened.push({ movie: m.name, chain, url: (next.sources[`${chain}|${m.name}`] || {}).url });
        }
      // When booking opens at a chain, every showtime there is "new"; one "booking open" alert covers it.
      newly = newly.filter((s) => !opened.some((o) => o.movie === s.movie && o.chain === s.chain));
    }
    log(`quick: ${next.shows.length} showtimes, ${next.shows.filter((s) => s.bookable).length} bookable, ${newly.length} newly on sale`);
    const count = await sendAlerts(cfg, { newly, opened, siteUrl: siteUrl(cfg) });

    // Grab seat maps for the new ones right away instead of waiting for the next seats pass.
    if (count && MODE === 'quick' && cfg.fetchSeatMaps) {
      spawn(process.execPath, [path.join(DIR, 'scan.js'), '--seats', '--fresh-only'], { cwd: DIR, detached: true, stdio: 'ignore' }).unref();
    }
    if (count && cfg.openReportWhenNewShowtimesGoOnSale && process.platform === 'darwin') execFile('open', [REPORT], () => {});
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
    status({ quick: { running: false, lastRun: new Date().toISOString() } });
  }
}

// ---------- seats pass: seat maps for your seat-map cinemas ----------
async function seatsPass(cfg) {
  if (!cfg.fetchSeatMaps) return;
  const quick = readJson(QUICK, null);
  if (!quick) return log('no showtimes yet — run the quick pass first');
  const release = lock('seats');
  if (!release) return log('seats pass already running');
  const st = readJson(SEATS, { seats: {}, premiereUrls: {} });
  const live = new Set(quick.shows.map((s) => s.uid));
  for (const k of Object.keys(st.seats)) if (!live.has(k)) delete st.seats[k];
  for (const k of Object.keys(st.premiereUrls)) if (!live.has(k)) delete st.premiereUrls[k];

  const wanted = quick.shows.filter((s) => s.bookable && seatCinema(cfg, s) && !isExcluded(cfg, s.screen));
  const freshOnly = flag('--fresh-only');
  let ctx;
  try {
    status({ seats: { running: true, step: 'starting', pid: process.pid } });
    ctx = await launch('.browser-profile', cfg.headless);

    await Promise.all(
      CHAINS.map(async (chain) => {
        const provider = PROVIDERS[chain];
        const page = await ctx.newPage();
        const mine = wanted.filter((s) => s.chain === chain);

        // Premiere hides seat-page links; click through to find the ones we don't know yet.
        if (chain === 'premiere') {
          const missing = mine
            .filter((s) => !st.premiereUrls[s.uid])
            .sort((a, b) => isPriority(cfg, b.screen) - isPriority(cfg, a.screen) || a.iso.localeCompare(b.iso))
            .slice(0, cfg.maxPremiereLookupsPerScan);
          for (const m of cfg.movies.filter((x) => x.premiere)) {
            const targets = missing.filter((s) => s.movie === m.name);
            if (!targets.length) continue;
            status({ seats: { running: true, step: `Premiere: locating ${targets.length} seat pages`, pid: process.pid } });
            try {
              const urls = await provider.locateSeatPages(page, { ref: m.premiere, targets, budgetMs: 150000 });
              for (const s of targets) if (urls[s.key]) st.premiereUrls[s.uid] = urls[s.key];
            } catch (e) {
              log('premiere locate failed', e.message.split('\n')[0]);
            }
          }
          for (const s of mine) s.seatRef = st.premiereUrls[s.uid] || null;
        }

        const maxAge = cfg.seatMapMaxAgeMinutes * 60000;
        const age = (s) => (st.seats[s.uid] ? Date.now() - Date.parse(st.seats[s.uid].at) : Infinity);
        const jobs = mine
          .filter((s) => s.seatRef)
          .filter((s) => (freshOnly ? age(s) === Infinity : isPriority(cfg, s.screen) ? age(s) > 4 * 60000 : age(s) > maxAge))
          .sort((a, b) => (age(b) === Infinity) - (age(a) === Infinity) || isPriority(cfg, b.screen) - isPriority(cfg, a.screen) || age(b) - age(a))
          .slice(0, cfg.maxSeatMapsPerChain);
        let i = 0;
        for (const s of jobs) {
          status({ seats: { running: true, step: `${provider.label}: seat map ${++i}/${jobs.length}`, pid: process.pid } });
          await sleep(cfg.delayBetweenRequestsMs);
          try {
            const map = await provider.seatMap(page, s);
            if (map && map.rows && map.rows.length) st.seats[s.uid] = { at: new Date().toISOString(), map };
          } catch (e) {
            log(chain, 'seat map failed', s.cinema, s.iso, s.time, String(e.message || e).split('\n')[0]);
          }
        }
        await page.close().catch(() => {});
      })
    );
    st.at = new Date().toISOString();
    writeJson(SEATS, st);
    log(`seats: ${Object.keys(st.seats).length} seat maps cached, ${Object.keys(st.premiereUrls).length} Premiere seat pages known`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
    status({ seats: { running: false, lastRun: new Date().toISOString() } });
  }
}

// ---------- outputs: data.json, report.html, GitHub ----------
async function publish(cfg) {
  const data = buildData(cfg, { site: siteUrl(cfg) });
  fs.writeFileSync(REPORT, renderUi('file', { cfg, data }));
  if (cfg.github && cfg.github.enabled) {
    try {
      await publishSite(cfg, renderUi('github', { cfg }));
      if (await publishData(cfg, data)) log('published data to GitHub');
      status({ publish: { ok: true, at: new Date().toISOString() } });
    } catch (e) {
      log('GitHub publish failed:', e.message);
      status({ publish: { ok: false, error: e.message, at: new Date().toISOString() } });
    }
  }
}

async function main() {
  const cfg = loadConfig();
  if (flag('--headed')) cfg.headless = false;

  if (args[0] === 'login') {
    const ctx = await launch('.browser-profile', false);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(LOGIN_URLS[args[1]] || LOGIN_URLS.vox, { waitUntil: 'domcontentloaded' });
    console.log('\nSign in in the window that opened, then close it. The scanner reuses the session.\n');
    await new Promise((r) => ctx.on('close', r));
    return;
  }
  if (MODE === 'discover') {
    const ctx = await launch('.browser-profile-quick', cfg.headless);
    try {
      await discover(ctx, cfg);
    } finally {
      await ctx.close();
    }
    return;
  }
  if (MODE === 'quick' || MODE === 'both') await quickPass(cfg);
  if (MODE === 'seats' || MODE === 'both') await seatsPass(cfg);
  await publish(cfg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
