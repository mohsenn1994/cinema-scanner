#!/usr/bin/env node
// Local app: the Seat Finder UI at http://localhost:4848 and scanner settings at /settings.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { DIR, CHAINS, CHAIN_LABELS, loadConfig, saveConfig, loadCatalog, loadSecrets, saveSecrets, readJson } = require('./lib/config');
const { renderUi } = require('./lib/ui');
const { setup } = require('./lib/publish');
const { ntfy } = require('./lib/alerts');

const PORT = Number(process.env.PORT || 4848);
const DATA = path.join(DIR, 'data.json');
const STATUS = path.join(DIR, '.scan-status.json');
const LOG = path.join(DIR, 'scan.log');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function readStatus() {
  const s = readJson(STATUS, {});
  for (const k of ['quick', 'seats']) if (s[k] && s[k].running && !alive(s[k].pid)) s[k].running = false;
  return s;
}
function run(args) {
  const out = fs.openSync(LOG, 'a');
  spawn(process.execPath, [path.join(DIR, 'scan.js'), ...args], { cwd: DIR, detached: true, stdio: ['ignore', out, out] }).unref();
}
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return send(res, 200, renderUi('server'), 'text/html; charset=utf-8');
    if (p === '/report') return res.writeHead(302, { Location: '/' }).end();
    if (p === '/data.json') return fs.existsSync(DATA) ? send(res, 200, fs.readFileSync(DATA, 'utf8')) : send(res, 404, { error: 'No data yet — the first scan takes a few minutes.' });
    if (p === '/settings') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (p === '/api/state') {
      const cfg = loadConfig();
      return send(res, 200, { config: cfg, catalog: loadCatalog(), status: readStatus(), chains: CHAINS, labels: CHAIN_LABELS, hasToken: !!loadSecrets().githubToken });
    }
    if (p === '/api/status') return send(res, 200, readStatus());
    return send(res, 404, { error: 'not found' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  // Only this page may change settings (blocks other websites from posting to localhost).
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'forbidden' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};
      if (p === '/api/config') return send(res, 200, { config: saveConfig(data) });
      if (p === '/api/request') {
        handleRequest(JSON.stringify(data));
        return send(res, 200, { ok: true });
      }
      if (p === '/api/scan') {
        const st = readStatus();
        const which = data.which || 'quick';
        if (which === 'discover') run(['--discover']);
        else if ((st[which] || {}).running) return send(res, 409, { error: `The ${which} scan is already running` });
        else run([`--${which}`]);
        return send(res, 200, { started: true });
      }
      if (p === '/api/ntfy-test') {
        const cfg = loadConfig();
        const ok = await ntfy({ ...cfg, ntfy: { ...cfg.ntfy, enabled: true } }, { title: 'Seat Finder test', message: 'Alerts are working. You will get one of these the moment tickets go on sale.', tags: 'white_check_mark' });
        return send(res, ok ? 200 : 502, ok ? { ok } : { error: 'ntfy did not accept the message — check the server and topic.' });
      }
      if (p === '/api/github') {
        if (data.token) saveSecrets({ githubToken: data.token.trim() });
        const cfg = saveConfig({ ...loadConfig(), github: { ...loadConfig().github, owner: data.owner.trim(), repo: data.repo.trim(), enabled: true } });
        const r = await setup(cfg, renderUi('github', { cfg }));
        run(['--quick']); // publish data straight away
        return send(res, 200, r);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: String(e.message || e) });
    }
  });
});

// The web page posts requests to an ntfy topic; this Mac listens and does the work:
//   {type:'check', id, focus}  → check showtimes everywhere, then count seats for what the person is viewing
//   {type:'seats', id, uid}    → count seats for one showtime right now
let lastManual = 0;
const lastSeat = {};
function handleRequest(raw) {
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    req = { type: 'check' };
  }
  const id = String(req.id || Date.now()).slice(0, 40);
  if (req.type === 'seats' && req.uid) {
    if (Date.now() - (lastSeat[req.uid] || 0) < 15000) return;
    lastSeat[req.uid] = Date.now();
    console.log(new Date().toISOString(), 'live seats requested', req.uid);
    return run(['--seat', String(req.uid), '--reply', id]);
  }
  const st = readStatus();
  if ((st.quick || {}).running || Date.now() - lastManual < 45000) return;
  lastManual = Date.now();
  console.log(new Date().toISOString(), 'Check now requested from the page');
  const focus = req.focus ? JSON.stringify(req.focus).slice(0, 2000) : null;
  run(['--quick', '--reply', id, ...(focus ? ['--focus', focus] : [])]);
}
async function listenForCheckNow() {
  for (;;) {
    let cfg = loadConfig();
    if (!cfg.trigger.topic) {
      cfg = saveConfig({ ...cfg, trigger: { ...cfg.trigger, topic: 'seatfinder-scan-' + crypto.randomBytes(6).toString('hex') } });
    }
    try {
      const res = await fetch(`${cfg.trigger.server.replace(/\/$/, '')}/${encodeURIComponent(cfg.trigger.topic)}/json?since=1m`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.event !== 'message') continue;
          if (Date.now() / 1000 - msg.time > 120) continue; // old request
          handleRequest(msg.message);
        }
      }
    } catch (e) {
      /* network blip — reconnect */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
listenForCheckNow();

server.listen(PORT, '127.0.0.1', () => {
  const u = `http://localhost:${PORT}`;
  console.log(`Seat Finder: ${u}    Settings: ${u}/settings    (Ctrl+C to stop)`);
  if (process.platform === 'darwin' && !process.argv.includes('--no-open')) execFile('open', [process.argv.includes('--settings') ? `${u}/settings` : u], () => {});
});

const randomTopic = () => 'seatfinder-' + crypto.randomBytes(5).toString('hex');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scanner Settings</title>
<style>
:root{--bg:#f5f4f2;--card:#fff;--ink:#17161a;--muted:#77737d;--line:#e6e3df;--accent:#c2185b;--ok:#17803d;--bad:#b42318;--vox:#1d4ed8;--scene:#7c3aed;--premiere:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#111013;--card:#1a191d;--ink:#eeedf1;--muted:#8f8b96;--line:#2c2a31;--accent:#ef4f8b;--ok:#4ade80;--bad:#f87171;--vox:#60a5fa;--scene:#a78bfa;--premiere:#f59e0b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 120px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 4px}
.muted{color:var(--muted)}.small{font-size:12px}.ok{color:var(--ok)}.bad{color:var(--bad)}
a{color:var(--accent)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:12px;color:var(--muted);font-weight:600}
select,input[type=text],input[type=password],input[type=number]{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}
input[type=number]{width:80px}
.scroll{overflow-x:auto}.movies td{min-width:150px}.movies td.narrow{min-width:0;width:40px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:10px 0}
.form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.chk{display:flex;gap:8px;align-items:center;padding:4px 0}
.tag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;color:#fff}.tag-vox{background:var(--vox)}.tag-scene{background:var(--scene)}.tag-premiere{background:var(--premiere)}
button{font:inherit;font-weight:600;border-radius:8px;padding:8px 14px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.link{border:none;background:none;color:var(--muted);padding:4px}
.actions{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px}
.actions .in{max-width:1100px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center}#status{margin-left:auto;font-size:12px;color:var(--muted)}
.opts{display:flex;flex-wrap:wrap;gap:18px;align-items:center}
ol{margin:6px 0;padding-left:20px}code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
</style></head><body><div class="wrap">
<h1>Scanner settings</h1><p class="muted">What your Mac checks when someone presses <b>Check now</b> on the page (nothing runs on a schedule). Seats are counted live when a showtime is opened. <a href="/" target="_blank">Open Seat Finder →</a></p>

<section><h2>Movies</h2><p class="small muted">Pick each movie's page at every chain, or "not at …". Movies that aren't on sale yet are watched too — you'll get an alert when booking opens.</p>
<div class="scroll"><table class="movies"><thead><tr><th class="narrow">On</th><th>Name</th><th><span class="tag tag-vox">VOX</span></th><th><span class="tag tag-scene">Scene</span></th><th><span class="tag tag-premiere">Premiere</span></th><th class="narrow"></th></tr></thead><tbody id="movies"></tbody></table></div>
<div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap"><select id="addMovie" style="max-width:420px"></select><button id="addBtn">Add movie</button></div>
</section>

<section><h2>Seat-map cinemas</h2><p class="small muted">Showtimes are read for <b>every</b> cinema, and opening any showtime counts its seats live. These cinemas also get seat maps from the full seat refresh button below.</p><div class="cols" id="cinemas"></div></section>

<section><h2>Screens</h2><p class="small muted">"Seat maps" off = skip seat maps for that screen. "Live" = refresh its seat maps every seats pass (others every 30 min).</p>
<table><thead><tr><th>Screen</th><th>Seen at</th><th>Seat maps</th><th>Live</th></tr></thead><tbody id="screens"></tbody></table></section>

<section><h2>Phone alerts (ntfy)</h2>
<p class="small muted">Free, no account. Everyone who subscribes to the topic gets an alert the moment tickets go on sale.</p>
<label class="chk"><input type="checkbox" id="ntfyOn"> Send alerts</label>
<div class="form"><label>Topic (anyone with the name can subscribe — keep it hard to guess)<input type="text" id="ntfyTopic"></label><label>Server<input type="text" id="ntfyServer"></label></div>
<ol class="small"><li>Install <b>ntfy</b> on your phone (App Store / Google Play) and subscribe to the topic above.</li><li>Save, then <button id="ntfyTest" type="button">Send a test alert</button> <span id="ntfyMsg" class="small"></span></li><li>Share the topic name with friends.</li></ol>
</section>

<section><h2>Share online (GitHub Pages)</h2>
<p class="small muted">Publishes Seat Finder to <code>https://&lt;you&gt;.github.io/&lt;repo&gt;/</code> for friends. Your Mac keeps scanning and pushes fresh data every few minutes.</p>
<ol class="small">
<li>Create a <b>public</b> repository on github.com (e.g. <code>seat-finder</code>). Empty is fine.</li>
<li>Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>: Repository access → only that repo; Permissions → <b>Contents</b>, <b>Pages</b> and <b>Workflows</b>: Read and write (Workflows lets it install the backup scanner).</li>
<li>Fill in below and press Connect. The token stays on this Mac (in <code>.secrets.json</code>).</li></ol>
<div class="form"><label>GitHub username<input type="text" id="ghOwner" autocomplete="off"></label><label>Repository<input type="text" id="ghRepo" autocomplete="off"></label><label>Token<input type="password" id="ghToken" autocomplete="off" placeholder=""></label></div>
<label class="chk"><input type="checkbox" id="ghOn"> Keep publishing</label>
<p><button class="primary" id="ghConnect" type="button">Connect &amp; publish</button> <span id="ghMsg" class="small"></span></p>
</section>

<section><h2>Options</h2><div class="opts">
<label>Days ahead (0 = all published) <input type="number" id="days" min="0" max="60"></label>
<label>Seats together <input type="number" id="partySize" min="1" max="10"></label>
<label class="chk"><input type="checkbox" id="fetchSeatMaps"> Seat maps</label>
<label class="chk"><input type="checkbox" id="macNotification"> Mac notifications</label>
</div></section>
</div>
<div class="actions"><div class="in">
<button class="primary" id="save">Save</button><button id="scanQuick">Check showtimes now</button><button id="scanSeats">Refresh seats now</button><button id="discover">Refresh lists</button><a href="/" target="_blank"><button type="button">Open Seat Finder</button></a><span id="status"></span>
</div></div>
<script>
var S, chains, labels;
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var sq=function(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'')};
function cat(ch){return (S.catalog.chains&&S.catalog.chains[ch])||{movies:[],cinemas:[],screens:[],sites:[],comingSoon:[]}}
function allMovies(ch){var c=cat(ch);return (c.movies||[]).concat((c.comingSoon||[]).filter(function(m){return ch==='vox'}).map(function(m){return {id:m.id,title:m.title+' (coming soon)',base:m.title}}))}
function bestMatch(ch,title){
  var list=allMovies(ch), t=sq(title), hit=list.find(function(m){return sq(m.base||m.title)===t});
  if(!hit) hit=list.find(function(m){var x=sq(m.base||m.title);return x&&(x.indexOf(t)>=0||t.indexOf(x)>=0)});
  return hit?hit.id:'';
}
function movieSelect(ch,val,i){
  var list=allMovies(ch), o='<option value="">— not at '+labels[ch]+' —</option>';
  if(val&&!list.some(function(m){return m.id===val})) list.unshift({id:val,title:val});
  list.forEach(function(m){o+='<option value="'+esc(m.id)+'"'+(m.id===val?' selected':'')+'>'+esc(m.title)+'</option>'});
  return '<select data-i="'+i+'" data-ch="'+ch+'">'+o+'<option value="__custom">Paste a link…</option></select>';
}
function renderMovies(){
  $('movies').innerHTML=S.config.movies.map(function(m,i){
    return '<tr><td class="narrow"><input type="checkbox" data-on="'+i+'"'+(m.enabled!==false?' checked':'')+'></td><td><input type="text" data-name="'+i+'" value="'+esc(m.name)+'"></td>'+
      chains.map(function(ch){return '<td>'+movieSelect(ch,m[ch]||'',i)+'</td>'}).join('')+'<td class="narrow"><button class="link" data-del="'+i+'" title="Remove">✕</button></td></tr>';
  }).join('');
  var titles={}, have=S.config.movies.map(function(m){return sq(m.name)});
  chains.forEach(function(ch){cat(ch).movies.forEach(function(m){var k=sq(m.title); if(!titles[k]) titles[k]={t:m.title,soon:false}}); (cat(ch).comingSoon||[]).forEach(function(m){var k=sq(m.title); if(!titles[k]) titles[k]={t:m.title,soon:true}})});
  var keys=Object.keys(titles).filter(function(k){return have.indexOf(k)<0}).sort(function(a,b){return titles[a].soon-titles[b].soon||titles[a].t.localeCompare(titles[b].t)});
  $('addMovie').innerHTML='<option value="">Choose a movie…</option>'+keys.map(function(k){return '<option value="'+esc(titles[k].t)+'">'+esc(titles[k].t)+(titles[k].soon?' — coming soon':'')+'</option>'}).join('')+'<option value="__blank">Blank row (paste links)</option>';
}
function idFromLink(ch,v){
  v=v.trim(); var m;
  if(ch==='vox'&&(m=v.match(/\\/movies\\/([a-z0-9-]+)/))) return m[1];
  if(ch==='scene'&&(m=v.match(/movie-details\\/([^/?#]+?)(\\.html)?(?:[?#]|$)/))) return m[1];
  if(ch==='premiere'&&(m=v.match(/movie-details\\/([\\d.]+)/))) return m[1];
  return v;
}
document.addEventListener('change',function(e){
  var t=e.target, i=t.dataset.i;
  if(t.dataset.ch!==undefined&&i!==undefined){
    var v=t.value;
    if(v==='__custom'){v=prompt('Paste the '+labels[t.dataset.ch]+' movie page link (or its id):')||''; v=idFromLink(t.dataset.ch,v);}
    if(v) S.config.movies[i][t.dataset.ch]=v; else delete S.config.movies[i][t.dataset.ch]; renderMovies();
  }
  if(t.dataset.on!==undefined) S.config.movies[t.dataset.on].enabled=t.checked;
  if(t.dataset.name!==undefined) S.config.movies[t.dataset.name].name=t.value;
  if(t.dataset.cin!==undefined){var c=JSON.parse(t.dataset.cin), ex=S.config.cinemas.find(function(x){return x.chain===c.chain&&sq(x.name)===sq(c.name)});
    if(ex) ex.enabled=t.checked; else S.config.cinemas.push({chain:c.chain,name:c.name,site:c.site,enabled:t.checked}); }
  if(t.dataset.inc!==undefined){var n=t.dataset.inc, ex2=S.config.excludedScreens; var k=ex2.indexOf(n); if(t.checked&&k>=0) ex2.splice(k,1); if(!t.checked&&k<0) ex2.push(n);}
  if(t.dataset.pri!==undefined){var p=t.dataset.pri, pr=S.config.priorityScreens; var j=pr.findIndex(function(x){return sq(x)===sq(p)}); if(t.checked&&j<0) pr.push(p); if(!t.checked&&j>=0) pr.splice(j,1);}
});
document.addEventListener('click',function(e){var d=e.target.dataset&&e.target.dataset.del; if(d!==undefined){S.config.movies.splice(Number(d),1); renderMovies();}});
$('addBtn').onclick=function(){
  var v=$('addMovie').value; if(!v) return;
  var m={name:v==='__blank'?'New movie':v,enabled:true};
  if(v!=='__blank') chains.forEach(function(ch){var id=bestMatch(ch,v); if(id) m[ch]=id;});
  S.config.movies.push(m); renderMovies();
};
function renderCinemas(){
  $('cinemas').innerHTML=chains.map(function(ch){
    var list=[], seen={};
    var add=function(c){var k=sq(c.name); if(!k||seen[k]) return; seen[k]=1; list.push(c)};
    S.config.cinemas.filter(function(c){return c.chain===ch}).forEach(add);
    if(ch==='scene') (cat(ch).sites||[]).forEach(function(s){add({chain:ch,name:s.name,site:s.site,enabled:false})});
    else (cat(ch).cinemas||[]).forEach(function(n){add({chain:ch,name:n,enabled:false})});
    list.sort(function(a,b){return a.name.localeCompare(b.name)});
    return '<div><h2><span class="tag tag-'+ch+'">'+labels[ch]+'</span></h2>'+(list.length?list.map(function(c){
      var on=S.config.cinemas.some(function(x){return x.chain===ch&&sq(x.name)===sq(c.name)&&x.enabled!==false});
      return '<label class="chk"><input type="checkbox" data-cin="'+esc(JSON.stringify({chain:ch,name:c.name,site:c.site}))+'"'+(on?' checked':'')+'> '+esc(c.name)+'</label>'}).join(''):'<p class="small muted">None found yet — they appear after the first scan.</p>')+'</div>';
  }).join('');
}
function renderScreens(){
  var map={};
  chains.forEach(function(ch){(cat(ch).screens||[]).forEach(function(s){var k=sq(s); map[k]=map[k]||{name:s,chains:[]}; if(map[k].chains.indexOf(ch)<0) map[k].chains.push(ch)})});
  S.config.excludedScreens.concat(S.config.priorityScreens).forEach(function(s){var k=sq(s); if(!map[k]) map[k]={name:s,chains:[]}});
  $('screens').innerHTML=Object.keys(map).sort(function(a,b){return map[a].name.localeCompare(map[b].name)}).map(function(k){var s=map[k];
    var inc=!S.config.excludedScreens.some(function(x){return sq(x)===k}), pri=S.config.priorityScreens.some(function(x){return sq(x)===k});
    return '<tr><td><b>'+esc(s.name)+'</b></td><td>'+(s.chains.map(function(c){return '<span class="tag tag-'+c+'">'+labels[c]+'</span>'}).join(' ')||'<span class="small muted">not seen yet</span>')+'</td><td><input type="checkbox" data-inc="'+esc(s.name)+'"'+(inc?' checked':'')+'></td><td><input type="checkbox" data-pri="'+esc(s.name)+'"'+(pri?' checked':'')+'></td></tr>'}).join('');
}
function renderOpts(){
  ['days','partySize'].forEach(function(k){$(k).value=S.config[k]});['fetchSeatMaps','macNotification'].forEach(function(k){$(k).checked=!!S.config[k]});
  $('ntfyOn').checked=!!S.config.ntfy.enabled; $('ntfyTopic').value=S.config.ntfy.topic||'${randomTopic()}'; $('ntfyServer').value=S.config.ntfy.server;
  $('ghOwner').value=S.config.github.owner||''; $('ghRepo').value=S.config.github.repo||''; $('ghOn').checked=!!S.config.github.enabled;
  $('ghToken').placeholder=S.hasToken?'saved — leave empty to keep':'github_pat_…';
  if(S.config.github.enabled&&S.config.github.owner) $('ghMsg').innerHTML='Live at <a target="_blank" href="https://'+esc(S.config.github.owner)+'.github.io/'+esc(S.config.github.repo)+'/">'+esc(S.config.github.owner)+'.github.io/'+esc(S.config.github.repo)+'</a>';
}
function readOpts(){
  S.config.days=Math.max(0,Number($('days').value)||0);S.config.partySize=Number($('partySize').value)||2;['fetchSeatMaps','macNotification'].forEach(function(k){S.config[k]=$(k).checked});
  S.config.ntfy={enabled:$('ntfyOn').checked,topic:$('ntfyTopic').value.trim(),server:$('ntfyServer').value.trim()||'https://ntfy.sh'};
  S.config.github.owner=$('ghOwner').value.trim(); S.config.github.repo=$('ghRepo').value.trim(); S.config.github.enabled=$('ghOn').checked;
}
function render(){renderMovies();renderCinemas();renderScreens();renderOpts();}
function post(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json().then(function(j){if(!r.ok) throw new Error(j.error||r.status); return j})})}
function save(){readOpts(); S.config.movies=S.config.movies.filter(function(m){return m.name&&(m.vox||m.scene||m.premiere)}); return post('/api/config',S.config).then(function(r){S.config=r.config; render(); flash('Saved')});}
function flash(t){$('status').textContent=t; setTimeout(poll,2500)}
$('save').onclick=save;
$('scanQuick').onclick=function(){save().then(function(){return post('/api/scan',{which:'quick'})}).then(function(){flash('Checking showtimes…')}).catch(function(e){flash(e.message)})};
$('scanSeats').onclick=function(){save().then(function(){return post('/api/scan',{which:'seats'})}).then(function(){flash('Refreshing seats…')}).catch(function(e){flash(e.message)})};
$('discover').onclick=function(){post('/api/scan',{which:'discover'}).then(function(){flash('Refreshing lists…')})};
$('ntfyTest').onclick=function(){save().then(function(){return post('/api/ntfy-test')}).then(function(){$('ntfyMsg').innerHTML='<span class="ok">Sent — check your phone.</span>'}).catch(function(e){$('ntfyMsg').innerHTML='<span class="bad">'+esc(e.message)+'</span>'})};
$('ghConnect').onclick=function(){
  $('ghMsg').textContent='Connecting…';
  save().then(function(){return post('/api/github',{owner:$('ghOwner').value,repo:$('ghRepo').value,token:$('ghToken').value})})
  .then(function(r){$('ghToken').value=''; S.hasToken=true; S.config.github.enabled=true; $('ghOn').checked=true; $('ghMsg').innerHTML='<span class="ok">Uploaded.</span> Your site: <a target="_blank" href="'+esc(r.url)+'">'+esc(r.url)+'</a>'+(r.pagesError?' <span class="bad">'+esc(r.pagesError)+'</span>':' (first deploy takes 1–2 minutes)')+(r.warning?' <span class="bad">'+esc(r.warning)+'</span>':'')+(r.private?' <span class="bad">The repo is private — make it public so friends can see it.</span>':'')})
  .catch(function(e){$('ghMsg').innerHTML='<span class="bad">'+esc(e.message)+'</span>'});
};
var was={};
function poll(){fetch('/api/status').then(function(r){return r.json()}).then(function(s){
  var q=s.quick||{}, se=s.seats||{}, parts=[];
  parts.push(q.running?'Showtimes: '+(q.step||'checking…'):'Showtimes checked '+(q.lastRun?new Date(q.lastRun).toLocaleTimeString():'—'));
  parts.push(se.running?'Seats: '+(se.step||'…'):'Seats '+(se.lastRun?new Date(se.lastRun).toLocaleTimeString():'—'));
  if(s.publish) parts.push(s.publish.ok?'GitHub ✓':'GitHub: '+s.publish.error);
  $('status').textContent=parts.join(' · ');
  if((was.q&&!q.running)) fetch('/api/state').then(function(r){return r.json()}).then(function(d){S.catalog=d.catalog; renderMovies(); renderCinemas(); renderScreens();});
  was={q:q.running};
})}
fetch('/api/state').then(function(r){return r.json()}).then(function(d){S=d; chains=d.chains; labels=d.labels; render(); poll(); setInterval(poll,3000);});
</script></body></html>`;
