# Seat Finder

Live showtimes and seats across **VOX**, **Scene** and **Premiere** cinemas in Egypt, with instant alerts when
tickets go on sale and one-tap links to each cinema's seat selection.

Your Mac does the scanning (cinema sites can't be read from a browser page directly):

| Job | How often | What it does |
|---|---|---|
| Showtimes check | every 2 min | Reads every cinema, every published date. Spots tickets going on sale → alerts. |
| Seat maps | every 10 min (and right after a sale opens) | Seat maps for your seat-map cinemas; premium screens first. |
| Seat Finder page | always on | http://localhost:4848 (settings at /settings) |

## Install (or update)
    cd ~/Documents/vox-scanner
    bash install.sh

## Use
- **Seat Finder** — double-click `Seat Finder.command` or open http://localhost:4848. Filter by movie, cinema,
  screen, 2D/3D, date and time (all multi-select), set "seats together", tap **Book**. **Share** copies a link
  that keeps your filters.
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
