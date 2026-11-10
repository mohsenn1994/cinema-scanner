// Runs INSIDE a premiere-cinemas.com movie page (via page.evaluate). The site loads showtimes through
// encrypted API calls, so we drive its UI instead: cinema → date → format → experience → time.
//
// task.type:
//   'dates'   → { dates: { cinema: ["Wed 16 Dec", …] } }              (cheap: one click per cinema)
//   'drill'   → { showtimes: [...], done: ["cinema|date", …] }        (times for chosen cinema/date pairs)
//   'capture' → { urls: { key: seatPageUrl } }                        (click a time → "Choose Seats")
async function premiereTask(task) {
  const { type, cinemas = [], targets = [], budgetMs = 45000 } = task || {};
  const deadline = Date.now() + budgetMs;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const waitFor = async (fn, t = 10000) => {
    const s = Date.now();
    while (Date.now() - s < t) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  };
  const heading = (title) =>
    [...document.querySelectorAll('p,h1,h2,h3,h4,span,div')].find((e) => e.children.length === 0 && norm(e.textContent) === norm(title));
  const buttonsUnder = (title) => {
    const h = heading(title);
    const box = h && h.parentElement && h.parentElement.parentElement;
    return box ? [...box.querySelectorAll('button')] : [];
  };
  const btnText = (b) => b.textContent.trim().replace(/\s+/g, ' ');
  const findBtn = (title, text) => buttonsUnder(title).find((b) => norm(btnText(b)) === norm(text));
  const dateEls = () => [...document.querySelectorAll('.dates-container')];
  const dateLabel = (el) => el.innerText.trim().replace(/\s+/g, ' ');
  const click = async (el, wait = 700) => {
    el.scrollIntoView({ block: 'center' });
    el.click();
    await sleep(wait);
  };
  const isTime = (t) => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t);
  const timeButtons = () => buttonsUnder('Choose Time').filter((b) => isTime(btnText(b)));

  async function select(p) {
    const cb = await waitFor(() => findBtn('Choose your cinema', p.cinema), 6000);
    if (!cb) return false;
    await click(cb, 900);
    const de = await waitFor(() => dateEls().find((e) => dateLabel(e) === p.date), 6000);
    if (!de) return false;
    await click(de, 900);
    if (p.format) {
      const fb = await waitFor(() => findBtn('Choose Formats', p.format), 5000);
      if (!fb) return false;
      await click(fb, 700);
    }
    if (p.experience) {
      const eb = await waitFor(() => findBtn('Choose Experience', p.experience), 5000);
      if (!eb) return false;
      await click(eb, 700);
    }
    return true;
  }

  await waitFor(() => buttonsUnder('Choose your cinema').length, 15000);
  const h = document.querySelector('h1, h2');
  const title = (h ? h.textContent : document.title).trim();
  const allCinemas = buttonsUnder('Choose your cinema').map(btnText);
  const wanted = allCinemas.filter((c) => !cinemas.length || cinemas.some((x) => norm(c).includes(norm(x)) || norm(x).includes(norm(c))));

  if (type === 'dates') {
    const dates = {};
    for (const cinema of wanted) {
      await click(findBtn('Choose your cinema', cinema), 1100);
      await waitFor(() => dateEls().length, 5000);
      dates[cinema] = dateEls().map(dateLabel);
    }
    return { title, cinemas: allCinemas, dates };
  }

  if (type === 'drill') {
    const showtimes = [];
    const done = [];
    for (const { cinema, date } of targets) {
      if (Date.now() > deadline) break;
      if (!(await select({ cinema, date }))) continue;
      await waitFor(() => buttonsUnder('Choose Formats').length || timeButtons().length, 5000);
      const formats = buttonsUnder('Choose Formats').map(btnText);
      for (const format of formats.length ? formats : [null]) {
        if (format) {
          await click(findBtn('Choose Formats', format), 800);
          await waitFor(() => buttonsUnder('Choose Experience').length || timeButtons().length, 5000);
        }
        const exps = buttonsUnder('Choose Experience').map(btnText);
        for (const experience of exps.length ? exps : [null]) {
          if (experience) {
            await click(findBtn('Choose Experience', experience), 800);
            await waitFor(() => timeButtons().length, 5000);
          }
          for (const b of timeButtons())
            showtimes.push({ cinema, date, format, experience, time: btnText(b), bookable: !b.disabled && b.getAttribute('aria-disabled') !== 'true' });
        }
      }
      done.push(`${cinema}|${date}`);
    }
    return { title, cinemas: allCinemas, showtimes, done };
  }

  // Select one showtime and press "Choose Seats"; the caller waits for the page to change.
  if (type === 'go') {
    const t = targets[0];
    if (!(await select(t))) return { ok: false, why: 'could not select' };
    const tb = await waitFor(() => timeButtons().find((b) => btnText(b) === t.time), 5000);
    if (!tb) return { ok: false, why: 'time not found' };
    await click(tb, 600);
    const go = await waitFor(() => [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === 'chooseseats'), 5000);
    if (!go) return { ok: false, why: 'no Choose Seats button' };
    setTimeout(() => go.click(), 50);
    return { ok: true };
  }

  if (type === 'capture') {
    const urls = {};
    for (const s of targets) {
      if (Date.now() > deadline) break;
      try {
        const start = location.href;
        if (!(await select(s))) continue;
        const tb = await waitFor(() => timeButtons().find((b) => btnText(b) === s.time), 5000);
        if (!tb) continue;
        await click(tb, 600);
        const go = await waitFor(() => [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === 'chooseseats'), 5000);
        if (!go) continue;
        go.click();
        if (await waitFor(() => location.pathname.includes('/seats/'), 10000)) urls[s.key] = location.href;
        history.back();
        await waitFor(() => location.href === start && buttonsUnder('Choose your cinema').length, 15000);
        await sleep(500);
      } catch (e) {
        /* skip this one */
      }
    }
    return { urls };
  }
  return { title, cinemas: allCinemas };
}

// Runs inside a /seats/... page.
function premiereSeats() {
  const box = document.querySelector('.seat-layout-container');
  const table = box && box.querySelector('table');
  if (!table) return null;
  const areas = {};
  const rows = [];
  let area = '';
  for (const tr of table.querySelectorAll('tr')) {
    if (!tr.querySelector('img')) {
      const t = tr.textContent.trim();
      const m = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      if (t) {
        area = m ? m[1].trim() : t;
        areas[area] = { label: area, price: m ? m[2] : '' };
      }
      continue;
    }
    rows.push(
      [...tr.querySelectorAll('td')].slice(1, -1).map((td) => {
        const img = td.querySelector('img');
        if (!img) return null;
        const file = (img.getAttribute('src') || '').split('/').pop().replace(/\.[0-9a-f]+\.svg$/i, '');
        const m = file.match(/^seat-(.+?)(-unavailable|-selected)?$/);
        return { l: (img.alt || '').replace(/^([A-Z]+)0*(\d+)$/, '$1-$2'), s: m && m[2] ? 0 : 1, c: m ? m[1] : 'standard', a: area };
      })
    );
  }
  const scr = box.querySelector('img[alt="scr_svg"]');
  return { areas, rows, screenAtTop: scr ? !!(scr.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) : true };
}

module.exports = { premiereTask, premiereSeats };
