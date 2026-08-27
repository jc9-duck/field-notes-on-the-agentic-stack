#!/usr/bin/env bash
set -euo pipefail

# switchyard-server is baked into this image (see Dockerfile's builder
# stage). Start it in the background on every container start rather than
# requiring a manual step — pi's switchyard-provider extension fetches
# from it at pi's own startup, so it needs to already be listening.
#
# --routing-log-file: one JSON record appended per routed response (which
# target was picked, timing, tokens) — the primary artifact for building a
# sequence diagram of routing decisions.
# RUST_LOG=debug: full tracing of the classifier call and decision logic,
# per switchyard-server's own README. Both land in the bind-mounted /work,
# so they're readable from the host without shelling into the container.
# >> not >: a truncating redirect here would wipe the whole debug trace on
# every container restart, while --routing-log-file below keeps appending —
# leaving the two files out of sync (exactly what broke render-trace.mjs
# after an unrelated restart discarded the log half of a still-referenced
# routing-log pair).
RUST_LOG=switchyard_server=debug,libsy=debug \
  switchyard-server --config /work/routes.toml --host 0.0.0.0 --port 4000 \
    --routing-log-file /work/switchyard-routing.jsonl \
  >> /work/.switchyard.log 2>&1 &

# Give it a moment to come up before anything tries to talk to it.
for _ in $(seq 1 20); do
  if curl -sf http://127.0.0.1:4000/health > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# trace-server.mjs: an always-running viewer over the two files above, not
# a one-shot generator. Reconstructs full request history on every page
# load — start it once here, leave it running, browse it whenever.
node /work/trace-server.mjs >> /work/.trace-server.log 2>&1 &

# failover-proxy.mjs: sits in front of switchyard-server (port 4000).
# Switchyard's classifier picks a target by task complexity, not
# availability — this adds the "if that target is actually down or
# rate-limited, retry a different provider" layer Switchyard itself
# doesn't have.
node /work/failover-proxy.mjs >> /work/.failover-proxy.log 2>&1 &

exec "$@"
