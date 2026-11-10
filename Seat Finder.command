#!/bin/bash
# Double-click to open Seat Finder (starts the local page if it isn't running).
cd "$(dirname "$0")"
if ! curl -s -o /dev/null http://localhost:4848/api/status; then
  (node settings.js --no-open >> scan.log 2>&1 &) ; sleep 1.5
fi
open "http://localhost:4848/"
