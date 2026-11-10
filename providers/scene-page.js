// Runs INSIDE a scenecinemas.com movie-details page (via page.evaluate).
// The page loads each day's showtimes from "<page>?business_day=DD-MM-YYYY&ajax=1".
async function sceneCollect(opts) {
  const { days = 7 } = opts || {};
  const base = location.href.split('?')[0].split('#')[0];
  const ids = [...document.querySelectorAll('[id^="data-"]')]
    .map((e) => e.id.slice(5))
    .filter((d) => /^\d{2}-\d{2}-\d{4}$/.test(d));
  const uniq = [...new Set(ids)].slice(0, days);
  const titleEl = document.querySelector('h1, h2, .movie-title');
  const title = (titleEl ? titleEl.textContent : document.title).replace(/^\s*\d+\+\s*/, '').trim();
  const showtimes = [];
  for (const d of uniq) {
    const [dd, mm, yyyy] = d.split('-');
    const html = await fetch(`${base}?business_day=${d}&ajax=1`, { credentials: 'include' }).then((r) => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const item of doc.querySelectorAll('.program_item')) {
      const branchEl = item.querySelector('.branch');
      const branch = (branchEl ? branchEl.textContent : '').replace(/^\s*Scene Cinema\s*-\s*/i, '').trim();
      for (const block of item.querySelectorAll('.showtimes > div')) {
        const expEl = block.querySelector(':scope > span');
        if (!expEl) continue;
        const experience = expEl.textContent.trim();
        for (const li of block.querySelectorAll('li')) {
          const a = li.querySelector('a[href]');
          const time = li.textContent.trim().replace(/\s+/g, ' ');
          const href = a ? a.href : null;
          showtimes.push({
            cinema: branch,
            iso: `${yyyy}-${mm}-${dd}`,
            experience,
            time,
            bookable: !!a && !a.classList.contains('disabled') && !li.classList.contains('disabled'),
            url: href,
            id: href ? href.split('/').pop() : null,
          });
        }
      }
    }
  }
  return { title, dates: uniq.map((d) => d.split('-').reverse().join('-')), showtimes };
}

// Runs INSIDE a scenecinemas.com showtime page once the seat plan has loaded.
function sceneSeats() {
  const hall = document.querySelector('#reservation-app-hall');
  if (!hall) return null;
  const SKIP = new Set(['Blank', 'SeatRowTitle']);
  const TAKEN = new Set(['Occupied', 'Hold', 'Selected', 'Unavailable', 'Blocked', 'Reserved', 'Sold']);
  const rows = [];
  let loaded = false;
  for (const row of hall.querySelectorAll('.reservation-app-hall-row')) {
    const els = [...row.querySelectorAll('.reservation-app-grid-element')];
    const titleEl = els.find((e) => e.getAttribute('app-type') === 'SeatRowTitle');
    const letter = titleEl ? titleEl.textContent.trim() : '';
    const cells = [];
    for (const e of els) {
      const type = e.getAttribute('app-type') || '';
      if (type) loaded = true;
      if (!type || SKIP.has(type)) {
        cells.push(null);
        continue;
      }
      const taken = TAKEN.has(type);
      const cat = taken ? 'standard' : type.toLowerCase();
      cells.push({ l: `${letter}-${e.getAttribute('app-name') || e.textContent.trim()}`, s: taken ? 0 : 1, c: cat, a: e.getAttribute('app-category-id') || '' });
    }
    rows.push(cells);
  }
  if (!loaded) return null;
  // Row "A" is nearest the screen; Scene lists rows from the back (M … A).
  const firstLetter = (rows[0] || []).find((x) => x && x.l)?.l.split('-')[0];
  return { areas: {}, rows, screenAtTop: firstLetter ? firstLetter === 'A' : false };
}

module.exports = { sceneCollect, sceneSeats };
