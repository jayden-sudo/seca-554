#!/bin/sh
# Headed Chrome needs a display. xvfb-run hangs when it is PID 1 in a container, so start Xvfb ourselves.
set -e
# A stopped and restarted container keeps the previous run's lock and socket; Xvfb refuses to start while they exist.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99
i=0
until [ -S /tmp/.X11-unix/X99 ]; do
  i=$((i + 1))
  if [ "$i" -gt 50 ] || ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "Xvfb did not start" >&2
    exit 1
  fi
  sleep 0.2
done
exec node dist/index.js "$@"
