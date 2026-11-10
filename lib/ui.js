// Produces the web UI in its three flavours from one template (web/app.html):
//   github → published to GitHub Pages, reads data from the repo's data branch
//   server → served by settings.js at http://localhost:4848, reads /data.json
//   file   → report.html you can double-click; data is embedded
const fs = require('fs');
const path = require('path');
const { DIR } = require('./config');

const TEMPLATE = path.join(DIR, 'web', 'app.html');

function renderUi(mode, { cfg, data } = {}) {
  let html = fs.readFileSync(TEMPLATE, 'utf8');
  let source = null;
  if (mode === 'github') source = { type: 'github', owner: cfg.github.owner, repo: cfg.github.repo, branch: cfg.github.dataBranch };
  if (mode === 'server') source = { type: 'url', url: '/data.json' };
  if (mode === 'file') source = { type: 'inline' };
  // JSON inside <script>: escape "<" so the data can't close the tag.
  const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  html = html.replace('/*__SOURCE__*/null', () => js(source)); // function form: data may contain "$&"
  html = html.replace('/*__DATA__*/null', () => (mode === 'file' && data ? js(data) : 'null'));
  return html;
}

module.exports = { renderUi };
