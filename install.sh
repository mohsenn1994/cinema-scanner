#!/bin/bash
# Installs dependencies and runs the Seat Finder helper in the background (launchd):
# it serves http://localhost:4848 and does a check whenever someone presses "Check now" or opens a showtime.
# Nothing is scanned on a schedule.
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
AGENTS="$HOME/Library/LaunchAgents"

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
for old in com.vox.seat-scanner com.seatfinder.quick com.seatfinder.seats; do
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
write_plist com.seatfinder.app "" "$DIR/settings.js" --no-open

echo
echo "✓ Installed. Nothing runs on a schedule — press Check now on the page."
echo "  Seat Finder: http://localhost:4848"
echo "  Settings:    http://localhost:4848/settings  (alerts, sharing on GitHub, what to scan)"
echo "  Log:         tail -f \"$DIR/scan.log\""
echo "  Stop:        bash uninstall.sh"
sleep 2 && open "http://localhost:4848/settings" 2>/dev/null || true
