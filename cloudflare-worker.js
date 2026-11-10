// Seat Finder relay — a free Cloudflare Worker that lets the public page start a GitHub Actions run.
// The page can't hold a GitHub token (anyone could read it), so this Worker keeps it as a secret and only
// allows two things: "check all showtimes" and "count seats for one showtime".
//
// Setup (Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file → Deploy), then in the
// Worker's Settings → Variables and Secrets:
//   REPO          = mohsenn1994/cinema-scanner              (plain text)
//   ALLOW_ORIGIN  = https://mohsenn1994.github.io           (plain text)
//   GITHUB_TOKEN  = a fine-grained token for that repo only, with "Actions: Read and write"   (secret)

const WORKFLOW = 'backup-scan.yml';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const okOrigin = !allowed.length || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin || '*' : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };
    const out = (code, body) => new Response(JSON.stringify(body), { status: code, headers: cors });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return out(405, { error: 'POST only' });
    if (!okOrigin) return out(403, { error: 'Not allowed from this site' });

    let body;
    try {
      body = await req.json();
    } catch {
      return out(400, { error: 'Bad request' });
    }
    const type = body.type === 'seats' ? 'seats' : 'check';
    const id = String(body.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
    const uid = type === 'seats' ? String(body.uid || '').slice(0, 200) : '';
    if (type === 'seats' && !uid) return out(400, { error: 'Missing showtime' });
    const focus = type === 'check' && body.focus ? JSON.stringify(body.focus).slice(0, 1500) : '';

    const gh = (path, init = {}) =>
      fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'seat-finder-relay', 'Content-Type': 'application/json' },
      });

    // Don't stack up full checks: if one is already queued or running, the page just waits for it.
    if (type === 'check') {
      for (const status of ['queued', 'in_progress']) {
        const r = await gh(`/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=20`);
        if (r.ok) {
          const runs = (await r.json()).workflow_runs || [];
          if (runs.some((x) => !/^Seats/i.test(x.display_title || ''))) return out(200, { ok: true, already: true });
        }
      }
    }

    const r = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: env.BRANCH || 'main', inputs: { type, id, uid, focus } }),
    });
    if (!r.ok) return out(502, { error: `GitHub said ${r.status}`, detail: (await r.text()).slice(0, 200) });
    return out(202, { ok: true });
  },
};
