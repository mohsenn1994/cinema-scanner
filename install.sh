#!/bin/bash
# Installs dependencies and sets up three background jobs on macOS (launchd):
#   showtimes check every 2 min · seat maps every 10 min · the Seat Finder page at http://localhost:4848
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
AGENTS="$HOME/Library/LaunchAgents"
QUICK_SEC="${1:-120}"
SEATS_SEC="${2:-600}"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Install it first (e.g. 'brew install node' or https://nodejs.org) and re-run."
  exit 1
fi

echo "→ Installing dependencies…"
npm install --silent
npx playwright install chromium   # fallback if Google Chrome isn't installed
chmod +x "Seat Finder.command" "Scanner Settings.command" uninstall.sh 2>/dev/null || true
mkdir -p "$AGENTS" state

# Remove jobs from earlier versions.
for old in com.vox.seat-scanner; do
  launchctl unload "$AGENTS/$old.plist" 2>/dev/null || true
  rm -f "$AGENTS/$old.plist"
done

write_plist() { # label, interval-or-empty, args...
  local label="$1" interval="$2"; shift 2
  local plist="$AGENTS/$label.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo "  <key>ProgramArguments</key><array><string>$NODE</string>"
    for a in "$@"; do echo "    <string>$a</string>"; done
    echo "  </array>"
    echo "  <key>WorkingDirectory</key><string>$DIR</string>"
    echo "  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>"
    if [ -n "$interval" ]; then
      echo "  <key>StartInterval</key><integer>$interval</integer>"
    else
      echo "  <key>KeepAlive</key><true/>"
    fi
    echo "  <key>RunAtLoad</key><true/>"
    echo "  <key>StandardOutPath</key><string>$DIR/scan.log</string>"
    echo "  <key>StandardErrorPath</key><string>$DIR/scan.log</string>"
    echo '</dict></plist>'
  } > "$plist"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
}

echo "→ Scheduling…"
write_plist com.seatfinder.quick "$QUICK_SEC" "$DIR/scan.js" --quick
write_plist com.seatfinder.seats "$SEATS_SEC" "$DIR/scan.js" --seats
write_plist com.seatfinder.app "" "$DIR/settings.js" --no-open

echo
echo "✓ Installed. Showtimes every $QUICK_SEC s, seat maps every $SEATS_SEC s."
echo "  Seat Finder: http://localhost:4848          (first results in 2–5 minutes)"
echo "  Settings:    http://localhost:4848/settings  (alerts, sharing on GitHub, what to scan)"
echo "  Log:         tail -f \"$DIR/scan.log\""
echo "  Stop:        bash uninstall.sh"
sleep 2 && open "http://localhost:4848/settings" 2>/dev/null || true
