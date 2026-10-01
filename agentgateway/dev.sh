#!/usr/bin/env bash
# Always rebuilds before running, so a stale image (e.g. after `git pull`
# brings in a Dockerfile/service change, or after your own edits) never
# silently ships. Docker's layer cache makes a no-op rebuild take a couple
# seconds -- not worth the "did I forget to rebuild" failure mode instead.
set -euo pipefail
cd "$(dirname "$0")"

docker compose build
# Brought up explicitly (not just via pi's depends_on) so docs-server's
# published port (3102, for the raw-vs-gated Inspector demo -- see README),
# agentgateway's own ports (4000 MCP proxy, 15000 admin UI), and both
# Inspector instances (mcp-inspector-docs-server on 7274/7275/7278,
# mcp-inspector-gateway on 7284/7285/7288) are all up before pi ever
# connects -- neither Inspector is a dependency of pi, so they're never
# started otherwise.
docker compose up -d math-server docs-server agentgateway mcp-inspector-docs-server mcp-inspector-gateway
# --service-ports *is* needed here: pi's own ports: block (switchyard-server
# on 6000, trace-server.mjs on 6321, mcp-trace-server.mjs on 6322,
# failover-proxy.mjs on 6100) is silently dropped by `docker compose run`
# without this flag -- the same gotcha documented in the repo's CLAUDE.md.
exec docker compose run --rm --service-ports pi
