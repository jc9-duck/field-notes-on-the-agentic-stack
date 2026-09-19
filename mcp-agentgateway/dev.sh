#!/usr/bin/env bash
# Always rebuilds before running, so a stale image (e.g. after `git pull`
# brings in a Dockerfile/service change, or after your own edits) never
# silently ships. Docker's layer cache makes a no-op rebuild take a couple
# seconds -- not worth the "did I forget to rebuild" failure mode instead.
set -euo pipefail
cd "$(dirname "$0")"

docker compose build
# --service-ports: `docker compose run` does NOT publish the `ports:`
# section by default (unlike `docker compose up`) -- without this flag,
# switchyard (5000), trace-server (5321), mcp-trace-server (5322), and
# failover-proxy (5100) all silently fail to bind on the host, even though
# they're running fine inside the container.
exec docker compose run --rm --service-ports pi
