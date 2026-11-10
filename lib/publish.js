// Publishes the web UI (gh-pages branch) and the data (data branch) to the user's GitHub repo.
// Each branch is a single commit that gets replaced, so the repo doesn't grow with every scan.
// The data lives on a separate branch so updating it doesn't trigger a GitHub Pages rebuild.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DIR, loadSecrets, readJson, writeJson } = require('./config');
const { log } = require('./util');

const PUB_STATE = path.join(DIR, 'state', 'publish.json');
const API = process.env.GITHUB_API || 'https://api.github.com';

// On the Mac the token comes from .secrets.json; inside GitHub Actions it's the workflow's GITHUB_TOKEN.
function repoOf(cfg) {
  const env = (process.env.GITHUB_REPOSITORY || '').split('/');
  return { owner: (cfg.github && cfg.github.owner) || env[0], repo: (cfg.github && cfg.github.repo) || env[1] };
}
function client(cfg) {
  const token = loadSecrets().githubToken || process.env.GITHUB_TOKEN;
  const { owner, repo } = repoOf(cfg);
  if (!token || !owner || !repo) return null;
  return async function api(method, p, body) {
    const res = await fetch(`${API}/repos/${owner}/${repo}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cinema-seat-scanner' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${p}: ${res.status} ${(json && json.message) || text.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };
}

async function replaceBranch(api, branch, files, message) {
  const tree = [];
  for (const [p, content] of Object.entries(files)) {
    const blob = await api('POST', '/git/blobs', { content: Buffer.from(content).toString('base64'), encoding: 'base64' });
    tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const t = await api('POST', '/git/trees', { tree });
  const c = await api('POST', '/git/commits', { message, tree: t.sha, parents: [] });
  try {
    await api('PATCH', `/git/refs/heads/${branch}`, { sha: c.sha, force: true });
  } catch (e) {
    if (e.status !== 422 && e.status !== 404) throw e;
    await api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: c.sha });
  }
  return c.sha;
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

// The scanner's own code (no secrets, browser profiles, scan state or logs) goes on the default branch.
const SKIP = /^(node_modules|\.browser-profile.*|state|\.git|\.secrets\.json|\.scan-status\.json|catalog\.json|data\.json|report\.html|report\.js|scan\.log|.*\.lock|.*\.tmp|\.DS_Store)$/;
function sourceFiles(dir = DIR, rel = '') {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.test(name)) continue;
    const full = path.join(dir, name);
    // GitHub workflow files are kept in github-workflows/ locally and uploaded to .github/workflows/.
    const r = (rel ? `${rel}/${name}` : name).replace(/^github-workflows(\/|$)/, '.github/workflows$1');
    const st = fs.statSync(full);
    if (st.isDirectory()) out = out.concat(sourceFiles(full, r));
    else if (st.size < 1024 * 1024) out.push({ path: r, full, exec: !!(st.mode & 0o111) || /\.(command|sh)$/.test(name) });
  }
  return out;
}

async function pushSource(api, branch) {
  try {
    return { count: await pushFiles(api, branch, sourceFiles()) };
  } catch (e) {
    // Fine-grained tokens need the extra "Workflows" permission to add .github/workflows files.
    if (!/workflow/i.test(e.message)) throw e;
    const count = await pushFiles(api, branch, sourceFiles().filter((f) => !f.path.startsWith('.github/')));
    return { count, warning: 'Code uploaded without the backup scanner. To switch the backup on, edit your token and add "Workflows: Read and write", then press Connect again.' };
  }
}

async function pushFiles(api, branch, files) {
  const tree = [];
  for (const f of files) {
    const blob = await api('POST', '/git/blobs', { content: fs.readFileSync(f.full).toString('base64'), encoding: 'base64' });
    tree.push({ path: f.path, mode: f.exec ? '100755' : '100644', type: 'blob', sha: blob.sha });
  }
  const t = await api('POST', '/git/trees', { tree });
  const head = await api('GET', `/git/ref/heads/${branch}`);
  const c = await api('POST', '/git/commits', { message: 'Upload Seat Finder scanner', tree: t.sha, parents: [head.object.sha] });
  await api('PATCH', `/git/refs/heads/${branch}`, { sha: c.sha });
  log(`uploaded ${files.length} source files to ${branch}`);
  return files.length;
}

// One-time setup: make sure the repo has a first commit, publish the UI, switch on GitHub Pages.
async function setup(cfg, uiHtml) {
  const api = client(cfg);
  if (!api) throw new Error('Add your GitHub username, repository and token first.');
  const repo = await api('GET', '');
  // repo.size lags behind pushes, so check for a branch instead.
  let empty = false;
  try {
    await api('GET', `/git/ref/heads/${repo.default_branch || 'main'}`);
  } catch (e) {
    if (e.status === 404 || e.status === 409) empty = true;
    else throw e;
  }
  if (empty) {
    // The Git Data API refuses to work on an empty repository.
    await api('PUT', '/contents/README.md', { message: 'Initial commit', content: Buffer.from(`# ${cfg.github.repo}\n\nCinema seat scanner. Site on the \`${cfg.github.pagesBranch}\` branch, data on \`${cfg.github.dataBranch}\`.\n`).toString('base64') });
  }
  const src = await pushSource(api, repo.default_branch || 'main');
  await publishSite(cfg, uiHtml, true);
  let pages = null;
  let pagesError = null;
  try {
    pages = await api('POST', '/pages', { source: { branch: cfg.github.pagesBranch, path: '/' } });
  } catch (e) {
    try {
      pages = await api('GET', '/pages'); // already switched on
    } catch {
      pagesError = `GitHub Pages isn't on yet. In the repo: Settings → Pages → Source "Deploy from a branch" → ${cfg.github.pagesBranch} / (root) → Save.`;
    }
  }
  return { url: (pages && pages.html_url) || `https://${cfg.github.owner}.github.io/${cfg.github.repo}/`, private: repo.private, pagesError, warning: src.warning };
}

async function publishSite(cfg, uiHtml, force) {
  const api = client(cfg);
  if (!api) return false;
  const st = readJson(PUB_STATE, {});
  const h = hash(uiHtml);
  if (!force && st.siteHash === h) return false;
  await replaceBranch(api, cfg.github.pagesBranch, { 'index.html': uiHtml, '.nojekyll': '' }, 'Update site');
  writeJson(PUB_STATE, { ...readJson(PUB_STATE, {}), siteHash: h });
  log('published site');
  return true;
}

// Push data when it changed, and at least every 5 minutes so viewers see it's alive.
// shared: files the GitHub Actions backup needs to carry on where the Mac left off (scan state, settings).
async function publishData(cfg, data, shared = {}) {
  const api = client(cfg);
  if (!api) return false;
  const body = JSON.stringify(data);
  const h = hash(JSON.stringify({ ...data, generatedAt: 0, quickAt: 0, seatsAt: 0 }));
  const st = readJson(PUB_STATE, {});
  if (st.dataHash === h && Date.now() - (st.dataAt || 0) < 5 * 60000) return false;
  const files = { 'data.json': body };
  for (const [k, v] of Object.entries(shared)) if (v) files[k] = JSON.stringify(v);
  await replaceBranch(api, (cfg.github && cfg.github.dataBranch) || 'data', files, `Data ${data.generatedAt}`);
  writeJson(PUB_STATE, { ...readJson(PUB_STATE, {}), dataHash: h, dataAt: Date.now() });
  return true;
}

// Read a JSON file from the data branch (fresh, via the API).
async function readShared(cfg, file) {
  const api = client(cfg);
  if (!api) return null;
  try {
    const r = await api('GET', `/contents/${file}?ref=${encodeURIComponent((cfg.github && cfg.github.dataBranch) || 'data')}`);
    if (r && r.content) return JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
    if (r && r.download_url) return await (await fetch(r.download_url)).json(); // files over 1 MB
  } catch (e) {
    if (e.status !== 404) log('could not read', file, 'from GitHub:', e.message);
  }
  return null;
}

module.exports = { setup, publishSite, publishData, readShared, client };
