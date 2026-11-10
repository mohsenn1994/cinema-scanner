const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const CONFIG = path.join(DIR, 'config.json');
const CATALOG = path.join(DIR, 'catalog.json');
const CHAINS = ['vox', 'scene', 'premiere'];
const CHAIN_LABELS = { vox: 'VOX', scene: 'Scene', premiere: 'Premiere' };

const DEFAULTS = {
  movies: [], // [{ name, enabled, vox, scene, premiere }]
  cinemas: [], // cinemas that get seat maps: [{ chain, name, site?, enabled }]. Showtimes are read for every cinema.
  excludedScreens: [], // screens that never get seat maps
  priorityScreens: ['MAX', 'IMAX', 'ScreenX', '4DX', 'MX4D'], // seat maps refreshed on every seats pass
  days: 0, // 0 = every date the cinemas publish
  partySize: 2,
  fetchSeatMaps: true,
  seatMapMaxAgeMinutes: 30,
  maxSeatMapsPerChain: 40,
  maxPremiereLookupsPerScan: 30,
  premiereRefreshMinutes: 20,
  headless: true,
  macNotification: true,
  openReportWhenNewShowtimesGoOnSale: false,
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
  github: { enabled: false, owner: '', repo: '', dataBranch: 'data', pagesBranch: 'gh-pages' },
  delayBetweenRequestsMs: 1500,
};

// Older configs were VOX-only: { movies: ["slug"], cinemas: ["name"], experiences: [...] }.
function migrate(c) {
  if (Array.isArray(c.movies) && typeof c.movies[0] === 'string') {
    c.movies = c.movies.map((slug) => ({ name: slug, enabled: true, vox: slug }));
  }
  if (Array.isArray(c.cinemas) && typeof c.cinemas[0] === 'string') {
    c.cinemas = c.cinemas.map((name) => ({ chain: 'vox', name, enabled: true }));
  }
  delete c.experiences;
  delete c.site;
  delete c.seatMapPriority;
  return c;
}

const withDefaults = (c) => ({ ...DEFAULTS, ...c, ntfy: { ...DEFAULTS.ntfy, ...(c.ntfy || {}) }, github: { ...DEFAULTS.github, ...(c.github || {}) } });

function loadConfig() {
  const raw = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
  return withDefaults(migrate(raw));
}

function saveConfig(c) {
  const clean = withDefaults(migrate(c));
  delete clean.github.token; // the token lives in .secrets.json only
  const tmp = CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG);
  return clean;
}

// Secrets (GitHub token) stay on this Mac and are git-ignored.
const SECRETS = path.join(DIR, '.secrets.json');
function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  } catch {
    return {};
  }
}
function saveSecrets(s) {
  fs.writeFileSync(SECRETS, JSON.stringify({ ...loadSecrets(), ...s }, null, 2), { mode: 0o600 });
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  } catch {
    return { updatedAt: null, chains: {} };
  }
}

// Union new findings into the catalog so the settings page can offer them.
function mergeCatalog(update) {
  const cat = loadCatalog();
  cat.chains = cat.chains || {};
  for (const [chain, u] of Object.entries(update.chains || {})) {
    const c = (cat.chains[chain] = cat.chains[chain] || { movies: [], cinemas: [], screens: [], sites: [] });
    for (const key of ['cinemas', 'screens']) {
      for (const v of u[key] || []) if (v && !c[key].includes(v)) c[key].push(v);
      c[key].sort();
    }
    if (u.movies && u.movies.length) c.movies = u.movies; // movie lists are replaced (films leave cinemas)
    if (u.comingSoon) c.comingSoon = u.comingSoon;
    for (const s of u.sites || []) if (!c.sites.some((x) => x.site === s.site)) c.sites.push(s);
  }
  if (update.discoveredAt) cat.updatedAt = update.discoveredAt;
  writeJson(CATALOG, cat);
  return cat;
}

module.exports = { DIR, CONFIG, CHAINS, CHAIN_LABELS, loadConfig, saveConfig, loadCatalog, mergeCatalog, loadSecrets, saveSecrets, writeJson, readJson };
