#!/bin/sh
set -e

# When Docker RESTARTS a crashed container it keeps the old filesystem, so the previous run's
# leftovers are still there: the audio server's socket/pid files make a new one refuse to start
# ("Daemon startup failed" in a loop), and stale X lock files make the virtual screens refuse too.
# Sweep them first. (A fresh container has nothing to sweep.)
rm -rf "$XDG_RUNTIME_DIR"/pulse "$XDG_RUNTIME_DIR"/pulse-* /tmp/pulse-* /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null || true

# A virtual sound card server. Minimal on purpose: no hardware probing.
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio -D --exit-idle-time=-1 --disallow-exit -n --load="module-native-protocol-unix" --log-target=stderr

# Local proof-of-life only: serve the fake class page so the pipeline can be
# tested without LiveKit. Never enabled in production.
if [ "$SERVE_FIXTURES" = "1" ]; then
  node fixtures/serve.mjs &
fi

exec node dist/main.js
