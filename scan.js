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
const { norm, squash, sleep, log, nameMatches, parseTime } = require('./lib/util');
const { buildData, encodeSeats, STATE_DIR, QUICK, SEATS } = require('./lib/data');
const { sendAlerts } = require('./lib/alerts');
const { publishData, publishSite, readShared } = require('./lib/publish');
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
const CI = !!process.env.GITHUB_ACTIONS; // running as the GitHub Actions backup
const MODE = flag('--seat') ? 'seat' : flag('--quick') ? 'quick' : flag('--seats') ? 'seats' : flag('--discover') ? 'discover' : 'both';
fs.mkdirSync(STATE_DIR, { recursive: true });

// Bot protection (VOX uses Akamai) rejects headless Chrome. We hide the giveaways: the "HeadlessChrome"
// user agent and the automation flag. If a site still refuses, HEADED_FLAG switches to a real Chrome
// window parked off-screen.
const HEADED_FLAG = path.join(STATE_DIR, 'use-hidden-window');
const UA_FILE = path.join(STATE_DIR, 'user-agent.txt');

async function openContext(dir, opts) {
  try {
    return await chromium.launchPersistentContext(dir, { ...opts, channel: 'chrome' }); // real Chrome passes bot checks better
  } catch {
    return chromium.launchPersistentContext(dir, opts);
  }
}

async function launch(profile, headless) {
  const dir = path.join(DIR, profile);
  const hidden = headless && !fs.existsSync(HEADED_FLAG);
  const base = {
    headless: hidden,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
  if (hidden) {
    let ua = fs.existsSync(UA_FILE) ? fs.readFileSync(UA_FILE, 'utf8').trim() : '';
    if (!ua) {
      const probe = await openContext(dir, base);
      const p = probe.pages()[0] || (await probe.newPage());
      ua = (await p.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
      await probe.close();
      fs.writeFileSync(UA_FILE, ua);
    }
    base.userAgent = ua;
  } else if (headless) {
    base.args.push('--window-position=-32000,-32000', '--window-size=1280,900'); // off-screen, out of your way
  }
  const ctx = await openContext(dir, base);
  ctx.setDefaultTimeout(45000);
  if (process.env.VOX_TEST_ROUTES) await require(process.env.VOX_TEST_ROUTES)(ctx); // offline tests only
  return ctx;
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms).unref())]);

// Never let a stuck browser block future runs.
function watchdog(minutes) {
  setTimeout(() => {
    log(`run exceeded ${minutes} min — stopping`);
    process.exit(2);
  }, minutes * 60000).unref();
}

// Locks live in the system temp folder: macOS can refuse deleting files in Documents from background jobs.
function lock(name) {
  const f = path.join(require('os').tmpdir(), `seatfinder-${name}.lock`);
  if (fs.existsSync(f)) {
    const pid = Number(fs.readFileSync(f, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && Date.now() - fs.statSync(f).mtimeMs < (name === 'quick' ? 10 : 30) * 60000) return null;
    if (alive) try { process.kill(pid); } catch {} // stuck run from before
  }
  fs.writeFileSync(f, String(process.pid));
  return () => {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      try {
        fs.writeFileSync(f, '0'); // couldn't delete: mark as free instead
      } catch {}
    }
  };
}

async function waitForLock(name, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const r = lock(name);
    if (r || Date.now() > until) return r;
    await sleep(1500);
  }
}

// Tell the web page what's happening (it listens on the "<topic>-done" ntfy topic).
async function reply(cfg, payload) {
  const t = cfg.trigger || {};
  if (!t.topic) return;
  try {
    await fetch(`${t.server.replace(/\/$/, '')}/${encodeURIComponent(t.topic + '-done')}`, { method: 'POST', body: JSON.stringify(payload) });
  } catch (e) {
    log('reply failed', e.message);
  }
}
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// The page's current choices → which showtimes to count seats for after a "Check now".
function focusFilter(focus) {
  if (!focus || !focus.movie) return null;
  const SLOT = { morning: (k) => k < 720, afternoon: (k) => k >= 720 && k < 1020, evening: (k) => k >= 1020 && k < 1260, night: (k) => k >= 1260 };
  return (s) => {
    if (s.movie !== focus.movie) return false;
    if (focus.c && focus.c.length && !focus.c.includes(`${s.chain}:${s.cinema}`)) return false;
    if (focus.s && focus.s.length && !focus.s.includes(s.screen)) return false;
    if (focus.f && focus.f.length && !focus.f.includes(s.format || '2D')) return false;
    if (focus.day && s.iso !== focus.day) return false;
    if (focus.slot && focus.slot.length && !focus.slot.some((id) => SLOT[id] && SLOT[id](parseTime(s.time).sort))) return false;
    return true;
  };
}

// Count seats for one showtime right now (someone opened it on the page).
async function liveSeat(cfg, uid, id) {
  const quick = readJson(QUICK, null);
  const s = quick && quick.shows.find((x) => x.uid === uid);
  if (!s) return reply(cfg, { kind: 'seat', id, uid, error: 'Showtime not found — try Check now first.' });
  const release = await waitForLock('live', 90000);
  if (!release) return reply(cfg, { kind: 'seat', id, uid, error: 'Busy — try again in a moment.' });
  let ctx;
  try {
    await reply(cfg, { kind: 'started', id, what: 'seat' });
    ctx = await launch('.browser-profile-live', cfg.headless);
    const page = await ctx.newPage();
    const st = readJson(SEATS, { seats: {}, premiereUrls: {} });
    if (s.chain === 'premiere') {
      if (!st.premiereUrls[uid]) {
        const m = cfg.movies.find((x) => x.name === s.movie);
        const urls = await withTimeout(PROVIDERS.premiere.locateSeatPages(page, { ref: m.premiere, targets: [s], budgetMs: 40000 }), 60000, 'Premiere seat lookup');
        if (urls[s.key]) st.premiereUrls[uid] = urls[s.key];
      }
      s.seatRef = st.premiereUrls[uid] || null;
    }
    const map = await withTimeout(PROVIDERS[s.chain].seatMap(page, s), 75000, 'seat map');
    if (!map || !map.rows || !map.rows.length) throw new Error('no seat map on the page');
    const at = new Date().toISOString();
    const fresh = readJson(SEATS, { seats: {}, premiereUrls: {} });
    fresh.seats[uid] = { at, map };
    fresh.premiereUrls = { ...fresh.premiereUrls, ...st.premiereUrls };
    writeJson(SEATS, fresh);
    const seat = { at, ...encodeSeats(map, cfg.partySize) };
    // ntfy messages max out around 4 KB; send the counts alone if the full map is too big.
    const full = JSON.stringify({ kind: 'seat', id, uid, seat, url: st.premiereUrls[uid] });
    await reply(cfg, full.length < 3900 ? JSON.parse(full) : { kind: 'seat', id, uid, seat: { at, free: seat.free, total: seat.total, cats: seat.cats }, partial: true, url: st.premiereUrls[uid] });
    log('live seats', s.chain, s.cinema, s.iso, s.time, `${seat.free}/${seat.total}`);
  } catch (e) {
    await reply(cfg, { kind: 'seat', id, uid, error: String(e.message || e).split('\n')[0] });
    log('live seats failed', uid, e.message);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
  }
  await publish(cfg);
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
      const r = await withTimeout(PROVIDERS[chain].discover(page, { sites: sites.length ? sites : DEFAULT_SCENE_SITES }), 90000, `${chain} discovery`);
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
  let prev = readJson(QUICK, null);
  // If the GitHub backup scanned more recently than this Mac, continue from its state so nothing is alerted twice.
  if (cfg.github && cfg.github.enabled && !CI) {
    const shared = await readShared(cfg, 'quick.json');
    if (shared && shared.at && (!prev || Date.parse(shared.at) > Date.parse(prev.at || 0))) {
      prev = shared;
      log('continuing from the backup scanner\'s newer state');
    }
  }
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
            const t0 = Date.now();
            if (chain === 'vox') out = await withTimeout(provider.collect(page, { ref: m.vox, cinemas: null, delay: Math.min(cfg.delayBetweenRequestsMs, 1000) }), 180000, 'VOX');
            if (chain === 'scene') out = await withTimeout(provider.collect(page, { ref: m.scene, sites: sceneSites }), 180000, 'Scene');
            if (chain === 'premiere') {
              const known = (next.premiereKnown[m.premiere] = next.premiereKnown[m.premiere] || {});
              out = await withTimeout(provider.collect(page, { ref: m.premiere, cinemas: null, known, refreshMinutes: cfg.premiereRefreshMinutes }), 150000, 'Premiere');
              next.premiereDates[m.premiere] = out.dates;
            }
            log(chain, m.name, `${out.showtimes.length} showtimes (${out.showtimes.filter((x) => x.bookable).length} on sale) in ${Math.round((Date.now() - t0) / 1000)}s`);
            out.cinemasSeen.forEach((c) => seen[chain].cinemas.add(c));
            out.screensSeen.forEach((c) => seen[chain].screens.add(c));
            next.sources[key] = { url: out.url, title: out.title, ok: true };
            for (const s of out.showtimes) next.shows.push({ ...s, chain, movie: m.name });
          } catch (e) {
            const msg = String(e.message || e).split('\n')[0];
            log(chain, 'failed', m.name, msg);
            if (/HTTP2_PROTOCOL|Access Denied|blocked|ERR_CONNECTION_RESET/i.test(msg) && cfg.headless && !fs.existsSync(HEADED_FLAG)) {
              fs.writeFileSync(HEADED_FLAG, new Date().toISOString());
              log('site refused the hidden browser — next runs use a Chrome window parked off-screen');
            }
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

    if (count && cfg.openReportWhenNewShowtimesGoOnSale && process.platform === 'darwin') execFile('open', [REPORT], () => {});
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
    status({ quick: { running: false, lastRun: new Date().toISOString() } });
  }
}

// ---------- seats pass: seat maps for your seat-map cinemas ----------
// opts.filter: only these showtimes (e.g. what the person is looking at); opts.maxAgeMs: refresh older maps.
async function seatsPass(cfg, opts = {}) {
  if (!cfg.fetchSeatMaps) return;
  const quick = readJson(QUICK, null);
  if (!quick) return log('no showtimes yet — run the quick pass first');
  const release = await waitForLock('seats', 120000);
  if (!release) return log('seats pass already running');
  const st = readJson(SEATS, { seats: {}, premiereUrls: {} });
  const live = new Set(quick.shows.map((s) => s.uid));
  for (const k of Object.keys(st.seats)) if (!live.has(k)) delete st.seats[k];
  for (const k of Object.keys(st.premiereUrls)) if (!live.has(k)) delete st.premiereUrls[k];

  const wanted = opts.filter
    ? quick.shows.filter((s) => s.bookable && opts.filter(s)).slice(0, opts.cap || 30)
    : quick.shows.filter((s) => s.bookable && seatCinema(cfg, s) && !isExcluded(cfg, s.screen));
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
              const urls = await withTimeout(provider.locateSeatPages(page, { ref: m.premiere, targets, budgetMs: 150000 }), 240000, 'Premiere seat lookup');
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
          .filter((s) => (opts.maxAgeMs != null ? age(s) > opts.maxAgeMs : freshOnly ? age(s) === Infinity : isPriority(cfg, s.screen) ? age(s) > 4 * 60000 : age(s) > maxAge))
          .sort((a, b) => (age(b) === Infinity) - (age(a) === Infinity) || isPriority(cfg, b.screen) - isPriority(cfg, a.screen) || age(b) - age(a))
          .slice(0, cfg.maxSeatMapsPerChain);
        let i = 0;
        for (const s of jobs) {
          status({ seats: { running: true, step: `${provider.label}: seat map ${++i}/${jobs.length}`, pid: process.pid } });
          await sleep(cfg.delayBetweenRequestsMs);
          try {
            const map = await withTimeout(provider.seatMap(page, s), 90000, 'seat map');
            if (map && map.rows && map.rows.length) st.seats[s.uid] = { at: new Date().toISOString(), map };
          } catch (e) {
            log(chain, 'seat map failed', s.cinema, s.iso, s.time, String(e.message || e).split('\n')[0]);
          }
        }
        await page.close().catch(() => {});
      })
    );
    st.at = new Date().toISOString();
    // A live seat check may have written meanwhile: keep whichever map is newer.
    const onDisk = readJson(SEATS, { seats: {}, premiereUrls: {} });
    for (const [k, v] of Object.entries(onDisk.seats || {})) if (!st.seats[k] || Date.parse(v.at) > Date.parse(st.seats[k].at)) st.seats[k] = v;
    st.premiereUrls = { ...(onDisk.premiereUrls || {}), ...st.premiereUrls };
    writeJson(SEATS, st);
    log(`seats: ${Object.keys(st.seats).length} seat maps cached, ${Object.keys(st.premiereUrls).length} Premiere seat pages known`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
    status({ seats: { running: false, lastRun: new Date().toISOString() } });
  }
}

// ---------- outputs: data.json, report.html, GitHub ----------
async function publish(cfg, prevData) {
  const data = buildData(cfg, { site: siteUrl(cfg), scannedBy: CI ? 'backup' : 'mac' }, prevData);
  if (!CI) fs.writeFileSync(REPORT, renderUi('file', { cfg, data }));
  if (cfg.github && cfg.github.enabled) {
    try {
      if (!CI) await publishSite(cfg, renderUi('github', { cfg }));
      const { token, ...safeCfg } = cfg; // never publish secrets
      if (await publishData(cfg, data, { 'quick.json': readJson(QUICK, null), 'config.json': safeCfg })) log('published data to GitHub');
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
  watchdog(MODE === 'seat' ? 4 : MODE === 'quick' ? 12 : 25);
  if (MODE === 'seat') return liveSeat(cfg, argVal('--seat'), argVal('--reply'));
  const replyId = argVal('--reply');
  let prevData = null;
  if (CI) {
    // Backup mode: only work when the Mac has gone quiet, using the Mac's settings and state.
    const shared = await readShared({ github: {} }, 'data.json');
    const age = shared && shared.quickAt ? (Date.now() - Date.parse(shared.quickAt)) / 60000 : Infinity;
    if (age < Number(process.env.BACKUP_AFTER_MINUTES || 12) && !flag('--force')) return log(`data is ${Math.round(age)} min old — the Mac is scanning, nothing to do`);
    const sharedCfg = await readShared({ github: {} }, 'config.json');
    if (sharedCfg) Object.assign(cfg, sharedCfg, { headless: true, macNotification: false, github: { ...sharedCfg.github, enabled: true } });
    const q = await readShared(cfg, 'quick.json');
    if (q) writeJson(QUICK, q);
    prevData = shared;
    log(`backup scan: last data ${isFinite(age) ? Math.round(age) + ' min' : 'never'} old`);
  }
  if (replyId) await reply(cfg, { kind: 'started', id: replyId, what: 'check' });
  if (MODE === 'quick' || MODE === 'both') await quickPass(cfg);
  if (MODE === 'seats' || MODE === 'both') await seatsPass(cfg);
  await publish(cfg, prevData);
  if (replyId) await reply(cfg, { kind: 'times', id: replyId, at: new Date().toISOString() });
  // After a "Check now", count seats for what the person is looking at.
  let focus = null;
  try {
    focus = JSON.parse(argVal('--focus') || 'null');
  } catch {}
  const filter = focusFilter(focus);
  if (filter && !CI) {
    await seatsPass(cfg, { filter, cap: 24, maxAgeMs: 3 * 60000 });
    await publish(cfg, prevData);
  }
  if (replyId) await reply(cfg, { kind: 'done', id: replyId, at: new Date().toISOString() });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
