#!/usr/bin/env bash
# Always rebuilds before running, so a stale image (e.g. after `git pull`
# brings in a Dockerfile/service change, or after your own edits) never
# silently ships. Docker's layer cache makes a no-op rebuild take a couple
# seconds -- not worth the "did I forget to rebuild" failure mode instead.
set -euo pipefail
cd "$(dirname "$0")"

docker compose build
# Brought up explicitly (not just via pi's depends_on) so docs-server's
# published port (3002, for the raw-vs-gated Inspector demo -- see README)
# and agentgateway's own port (4000) are both up before pi ever connects.
docker compose up -d math-server docs-server agentgateway
# --service-ports doesn't currently do anything here -- pi has no ports: of
# its own in this folder (unlike mcp/'s pi, which bundles switchyard/trace
# viewers) -- but it costs nothing and avoids the same silent-port gotcha if
# one is ever added.
exec docker compose run --rm --service-ports pi
