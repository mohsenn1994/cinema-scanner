#!/bin/bash
# Stops all Seat Finder background jobs. Your files and settings stay in place.
AGENTS="$HOME/Library/LaunchAgents"
for label in com.seatfinder.quick com.seatfinder.seats com.seatfinder.app com.vox.seat-scanner; do
  launchctl unload "$AGENTS/$label.plist" 2>/dev/null || true
  rm -f "$AGENTS/$label.plist"
done
echo "✓ Seat Finder stopped."
