#!/bin/sh
set -e

# A virtual sound card server. Minimal on purpose: no hardware probing.
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio -D --exit-idle-time=-1 --disallow-exit -n --load="module-native-protocol-unix" --log-target=stderr

# Local proof-of-life only: serve the fake class page so the pipeline can be
# tested without LiveKit. Never enabled in production.
if [ "$SERVE_FIXTURES" = "1" ]; then
  node fixtures/serve.mjs &
fi

exec node dist/main.js
