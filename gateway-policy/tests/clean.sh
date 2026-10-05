#!/bin/bash
# Housekeeping for gateway-policy test runs.
#   bash gateway-policy/tests/clean.sh          # leftover containers/network, logs older than 14 days
#   bash gateway-policy/tests/clean.sh --all    # the above, plus delete every saved log
# Env: HARNESS_LOG_DIR (default tests/out), HARNESS_LOG_DAYS (default 14).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${HARNESS_LOG_DIR:-$HERE/out}"
DAYS="${HARNESS_LOG_DAYS:-14}"

docker rm -f gp-mock gp-gw >/dev/null 2>&1
docker network rm gp-test-net >/dev/null 2>&1
echo "removed leftover test containers/network (if any)"

if [ -d "$OUT" ]; then
  if [ "${1:-}" = "--all" ]; then
    rm -f "$OUT"/*.log "$OUT"/*.log.[0-9]* 2>/dev/null
    echo "deleted all saved logs"
  else
    find "$OUT" -type f -name '*.log*' -mtime +"$DAYS" -delete
    echo "deleted saved logs older than $DAYS days"
  fi
  du -sh "$OUT" 2>/dev/null | awk '{print "log dir size now: " $1}'
else
  echo "no saved logs yet ($OUT)"
fi
