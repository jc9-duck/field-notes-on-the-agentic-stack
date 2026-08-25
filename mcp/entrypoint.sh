#!/usr/bin/env bash
# Runs once per container start: configures git identity and, if a GH_TOKEN
# is present, points git's HTTPS credential helper at `gh` so push/pull work
# without touching SSH keys (the host's global SSH config forces an unrelated
# identity for all github.com hosts) or the macOS Keychain (unreadable from
# inside a Linux container).
set -euo pipefail

git config --global user.name "jc9-duck"
git config --global user.email "144706166+jc9-duck@users.noreply.github.com"

if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git
fi

exec "$@"
