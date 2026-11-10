# Seat Finder

Live showtimes and seats across **VOX**, **Scene** and **Premiere** cinemas in Egypt, with instant alerts when
tickets go on sale and one-tap links to each cinema's seat selection.

Nothing runs on a schedule. A small helper on your Mac does the work when someone uses the page:

- **Check now** (button on the page) — reads every cinema's showtimes (~1–2 min), then counts seats for the
  movie/cinemas/screen/day you're looking at.
- **Opening a showtime** — counts that showtime's seats live (~10–20 s) and shows the seat map.

Requests from the page travel through ntfy (free), so they work from the GitHub page and from friends' phones,
as long as the Mac is awake. When it's off, the repo owner can run a check from GitHub: Actions → "Check showtimes"
→ Run workflow.

## Install (or update)
    cd ~/Documents/vox-scanner
    bash install.sh

## Use
- **Seat Finder** — double-click `Seat Finder.command` or open http://localhost:4848: pick a movie, choose
  cinemas/screen/time, pick a showtime, tap **Book**. **Share** copies a link that keeps your choices.
- **Settings** — `Scanner Settings.command` or http://localhost:4848/settings: movies to watch (including
  coming-soon ones), which cinemas get seat maps, phone alerts, publishing to GitHub.

## Phone alerts (ntfy)
Settings → Phone alerts: tick "Send alerts", install the ntfy app, subscribe to the topic, "Send a test alert".
Share the topic name with friends.

## Share with friends (GitHub Pages)
1. Create a **public** repo on GitHub (e.g. `seat-finder`).
2. Create a fine-grained token for that repo only: Contents read/write, Pages read/write.
3. Settings → Share online → fill in and press **Connect & publish**.
The page lives at `https://<you>.github.io/<repo>/`. The Mac pushes data to the repo's `data` branch; the page reads
it live. Keep the Mac awake (System Settings → Battery/Energy → prevent sleep when plugged in).

## Notes
- Premiere hides showtime and seat links, so the scanner clicks through its site: a few cinema-days per check,
  new dates first. Its **Book** button opens the movie page until the seat page has been located.
- Optional sign-in for the seat-map pass: `npm run login` (VOX), `node scan.js login scene|premiere`.
- Logs: `scan.log`. Stop everything: `bash uninstall.sh`.
- If scans fail with "blocked", set `"headless": false` in config.json.
