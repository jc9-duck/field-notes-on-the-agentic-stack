#!/usr/bin/env bash
# Proves routes.smart-v2 (the mode="custom" 3-way task classifier in
# routes.toml) actually reads each prompt's content and picks the matching
# specialized target — not a fixed answer, not luck. Three cases, one per
# target: a trivial prompt (expect targets.local), a coding prompt (expect
# targets.coding), and a deep-reasoning prompt (expect targets.cloud).
#
# Run from inside the pi container (needs switchyard-server on
# 127.0.0.1:4000 and jq, both already baked into the image):
#   docker compose exec pi bash tests/test-custom-routing.sh
# or, for a one-off container:
#   docker compose run --rm pi bash tests/test-custom-routing.sh
#
# See tests/README.md for what this actually proves and its limits.
#
# EXPECTED_* below must match routes.toml's [targets.local]/[targets.coding]/
# [targets.cloud] ids — update both together if routes.toml changes.
set -uo pipefail

SWITCHYARD_URL="http://127.0.0.1:4000/v1/chat/completions"
EXPECTED_LOCAL="llama3.1:8b"
EXPECTED_CODING="mistral.devstral-2-123b"
EXPECTED_CLOUD="nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"

pass_count=0
fail_count=0

run_case() {
  local label="$1" prompt="$2" expected="$3"
  local body actual

  # Built with jq -n rather than shell string interpolation so prompt text
  # (apostrophes, quotes, newlines) can never break the request body.
  body=$(curl -s "$SWITCHYARD_URL" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg p "$prompt" '{model: "switchyard-v2", messages: [{role: "user", content: $p}]}')")

  actual=$(echo "$body" | jq -r '.model // empty')

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS  [$label] -> $actual"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL  [$label] expected=$expected actual=${actual:-<none>}"
    echo "      response: $(echo "$body" | head -c 300)"
    fail_count=$((fail_count + 1))
  fi
}

run_case "trivial" \
  "say hello in exactly 3 words" \
  "$EXPECTED_LOCAL"

run_case "coding" \
  "Write a Python function that reverses a singly linked list in place, and explain the pointer manipulation." \
  "$EXPECTED_CODING"

run_case "reasoning" \
  "Prove that there are infinitely many prime numbers, and discuss why Euclid's original proof strategy still matters historically for mathematics." \
  "$EXPECTED_CLOUD"

echo
echo "$pass_count passed, $fail_count failed"
[[ "$fail_count" -eq 0 ]]
