#!/usr/bin/env bash
# Always rebuilds before running, so a stale image (e.g. after `git pull`
# brings in a Dockerfile/service change, or after your own edits) never
# silently ships. Docker's layer cache makes a no-op rebuild take a couple
# seconds -- not worth the "did I forget to rebuild" failure mode instead.
set -euo pipefail
cd "$(dirname "$0")"

docker compose build
exec docker compose run --rm pi
