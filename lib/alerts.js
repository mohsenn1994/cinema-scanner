// Phone alerts through ntfy (https://ntfy.sh) plus a Mac notification.
const { execFile } = require('child_process');
const { CHAIN_LABELS } = require('./config');
const { isoLabel, parseTime, log } = require('./util');

async function ntfy(cfg, { title, message, click, tags = 'cinema', priority = 'high' }) {
  if (!cfg.ntfy || !cfg.ntfy.enabled || !cfg.ntfy.topic) return false;
  const headers = { Title: encodeURIComponent(title), Tags: tags, Priority: priority, 'Content-Type': 'text/plain; charset=utf-8' };
  if (click) headers.Click = click;
  // ntfy reads RFC 2047 / percent-encoded titles poorly on some clients, so send plain ASCII when possible.
  if (/^[\x20-\x7e]*$/.test(title)) headers.Title = title;
  try {
    const res = await fetch(`${cfg.ntfy.server.replace(/\/$/, '')}/${encodeURIComponent(cfg.ntfy.topic)}`, { method: 'POST', headers, body: message });
    if (!res.ok) log('ntfy failed', res.status);
    return res.ok;
  } catch (e) {
    log('ntfy failed', e.message);
    return false;
  }
}

function mac(title, body) {
  if (process.platform !== 'darwin') return;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

// newly: showtimes that just became bookable; opened: [{ movie, chain }] where booking just opened.
async function sendAlerts(cfg, { newly, opened, siteUrl }) {
  // Tapping an alert opens the shared page filtered to that movie, on-sale only.
  const link = (movie, single) => single || (siteUrl ? `${siteUrl}#m=${encodeURIComponent(movie)}&sale=1` : null);
  const groups = new Map();
  for (const s of newly) {
    const k = `${s.movie}|${s.chain}|${s.cinema}|${s.screen}|${s.format}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const lines = [];
  for (const list of groups.values()) {
    const s = list[0];
    const days = [...new Set(list.map((x) => x.iso))].sort();
    const times = list.length <= 4 ? list.map((x) => `${isoLabel(x.iso)} ${parseTime(x.time).label}`).join(', ') : `${list.length} showtimes, ${isoLabel(days[0])} – ${isoLabel(days[days.length - 1])}`;
    const fmt = s.format && s.format !== '2D' ? ` ${s.format}` : '';
    lines.push({ title: `${s.movie}: ${s.screen}${fmt} on sale`, message: `${CHAIN_LABELS[s.chain]} ${s.cinema}\n${times}`, click: link(s.movie, list.length === 1 ? s.bookUrl : null) || s.bookUrl });
  }
  for (const o of opened) lines.unshift({ title: `Booking open: ${o.movie}`, message: `${CHAIN_LABELS[o.chain]} has started selling tickets.`, click: link(o.movie) || o.url, tags: 'tada' });

  // Keep phones from buzzing 30 times: up to 5 alerts, then one summary.
  const send = lines.slice(0, 5);
  if (lines.length > 5) send.push({ title: `+${lines.length - 5} more on sale`, message: lines.slice(5).map((l) => l.title).join('\n'), click: siteUrl });
  for (const l of send) await ntfy(cfg, l);
  if (cfg.macNotification && lines.length) mac(lines[0].title, lines.length > 1 ? `${lines[0].message.split('\n')[0]} (+${lines.length - 1} more)` : lines[0].message);
  return lines.length;
}

module.exports = { sendAlerts, ntfy };
