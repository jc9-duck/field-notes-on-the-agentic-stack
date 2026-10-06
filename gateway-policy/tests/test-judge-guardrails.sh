#!/bin/bash
# End-to-end test of the LLM-judge guardrails: a real agentgateway + mock provider + the
# judge-webhook service backed by Ollama on this host.
#   A. built-in regex only        -> pin what it MISSES (the gap the judge fills)
#   B. built-in regex + LLM judge -> the same cases are caught, in both directions
#   C. judge down                 -> failClosed vs failOpen
# Needs: docker, curl, jq, and Ollama on localhost:11434 with the judge model pulled
# (default llama3.1:8b). SKIPS (exit 0) if Ollama or the model is missing.
# Run:  bash gateway-policy/tests/test-judge-guardrails.sh        (~3-4 min on a laptop)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GP="$HERE/.."
CASES="$GP/fixtures/judge-cases.json"
# shellcheck source=lib/harness.sh
source "$HERE/lib/harness.sh"

if ! harness_ollama_ready; then
  echo "SKIP: Ollama is not reachable on localhost:11434 with model '$JUDGE_MODEL' (ollama pull $JUDGE_MODEL)"
  exit 0
fi

PASS=0; FAIL=0; RETRIED=0; SLOW=0; TOTAL=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n        %s\n' "$1" "$2"; }
assert_eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected [$2] got [$3]"; }
assert_contains() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "expected to contain [$3] in [$2]";; esac; }
assert_lacks()    { case "$2" in *"$3"*) bad "$1" "must not contain [$3] in [$2]";; *) ok "$1";; esac; }

trap 'harness_save_log; harness_down' EXIT

case_field() { jq -r --arg id "$1" ".[] | select(.id == \$id) | $2" "$CASES"; }
case_text() {  # inline text, or the contents of a fixture file
  local t; t=$(case_field "$1" '.text // empty')
  if [ -z "$t" ]; then t=$(cat "$GP/fixtures/$(case_field "$1" '.text_file')"); fi
  printf '%s' "$t"
}

echo "== validating policies"
assert_eq "builtin-only policy validates" "Configuration is valid!" "$(harness_validate "$GP/llm-guardrails-builtin.yaml")"
assert_eq "judge policy validates"        "Configuration is valid!" "$(harness_validate "$GP/llm-judge.yaml")"

# ---------------------------------------------------------------- A: regex only
echo "== A. built-in regex only: what it misses (pinned; a version that closes a gap flags here)"
harness_up "$GP/llm-guardrails-builtin.yaml" || { echo "could not start harness"; exit 1; }
chat "my ssn is 987-65-4321"
assert_eq "sanity: built-in regex still rejects an SSN (403)" "403" "$HTTP"
for id in req-address req-account req-iban req-card-mc2 req-inject-ignore req-inject-indirect; do
  chat "$(case_text "$id")"
  assert_eq "regex-only lets it through: $id" "200" "$HTTP"
  if [ "$(case_field "$id" '.expect')" = "mask" ]; then
    while IFS= read -r s; do
      [ -n "$s" ] && assert_contains "  ...and the provider saw the raw value: $s" "$(upstream_saw)" "$s"
    done < <(case_field "$id" '.must_redact[]')
  fi
done
harness_save_log

# ---------------------------------------------------------------- B: regex + judge
echo "== B. built-in regex + LLM judge (model: $JUDGE_MODEL)"
rm -f "$HARNESS_LOG_DIR/judge-verdicts.jsonl" "$HARNESS_LOG_DIR/judge-verdicts.jsonl.1"
harness_up "$GP/llm-judge.yaml" || { echo "could not start harness"; exit 1; }
harness_start_judge || { echo "could not start judge"; exit 1; }
for id in $(jq -r '.[].id' "$CASES"); do
  dir=$(case_field "$id" '.direction'); expect=$(case_field "$id" '.expect'); text=$(case_text "$id")
  # The gateway gives a webhook a FIXED 10s and a local 8B judge sometimes needs longer on
  # multi-span answers, which fails closed as a 503. Retry such a case once, and count it:
  # the limitation is reported in the summary instead of hidden or turned into a flaky test.
  attempt() {
    if [ "$dir" = "response" ]; then
      mock_next_reply "$text"          # the provider's reply; the prompt itself is innocuous
      chat "Please summarize the open support ticket."
    else
      chat "$text"
    fi
  }
  attempt
  if [ "$HTTP" = "503" ]; then
    RETRIED=$((RETRIED+1)); echo "        ($id: 503, judge exceeded the gateway's 10s budget; retrying once)"
    attempt
  fi
  TOTAL=$((TOTAL+1))
  if [ "$HTTP" = "503" ]; then
    # Over budget twice: a latency result, not a verdict. Reported as SLOW (never as PASS),
    # and the suite fails below if too many cases land here.
    SLOW=$((SLOW+1)); echo "  SLOW  $id: judge exceeded the gateway's 10s budget twice (503, failClosed)"
    continue
  fi
  if [ "$dir" = "response" ]; then seen="$(assistant_said)"; else seen="$(upstream_saw)"; fi
  case "$expect" in
    reject)
      assert_eq "$id: judge rejects (451, not the regex 403)" "451" "$HTTP"
      [ "$HTTP" = "451" ] && assert_contains "  ...with the judge's message" "$BODY" "LLM judge"
      ;;
    mask)
      assert_eq "$id: ($dir) goes through" "200" "$HTTP"
      # Dependent checks only make sense if the request got through; otherwise they would
      # read stale data from a previous case.
      if [ "$HTTP" = "200" ]; then
        assert_contains "  ...redaction placeholder present" "$seen" "<REDACTED:"
        while IFS= read -r s; do
          [ -n "$s" ] && assert_lacks "  ...value withheld: $s" "$seen" "$s"
        done < <(case_field "$id" '.must_redact[]')
      fi
      ;;
    pass)
      assert_eq "$id: ($dir) passes" "200" "$HTTP"
      [ "$HTTP" = "200" ] && assert_lacks "  ...untouched by the judge" "$seen" "<REDACTED:"
      ;;
  esac
done

echo "== verdict log (decisions only, never the text)"
VLOG="$HARNESS_LOG_DIR/judge-verdicts.jsonl"
if [ -f "$VLOG" ]; then
  assert_contains "log records a reject"  "$(cat "$VLOG")" '"action":"reject"'
  assert_contains "log records a mask"    "$(cat "$VLOG")" '"action":"mask"'
  assert_contains "log records a pass"    "$(cat "$VLOG")" '"action":"pass"'
  leak=""
  for s in "20 Ingram Street" "000123456701" "GB82 WEST" "2223 0031" "Tr0ub4dor" "tok_demo_" "Ignore all previous"; do
    grep -q -F "$s" "$VLOG" && leak="$leak [$s]"
  done
  assert_eq "log contains no request or response text" "" "$leak"
else
  bad "judge verdict log exists" "no $VLOG"
fi
harness_save_log

# ---------------------------------------------------------------- C: judge down
echo "== C. judge unavailable: failClosed vs failOpen"
harness_up "$GP/llm-judge.yaml" || { echo "could not start harness"; exit 1; }
harness_start_judge || { echo "could not start judge"; exit 1; }
harness_stop_judge
chat "What is the capital of France?"
echo "        (observed with failClosed and the judge down: HTTP $HTTP)"
[ "$HTTP" != "200" ] && ok "failClosed: a clean request is NOT let through when the judge is down" || bad "failClosed blocks when the judge is down" "got HTTP 200"
harness_save_log

FAILOPEN="$HARNESS_LOG_DIR/llm-judge-failopen.yaml"
mkdir -p "$HARNESS_LOG_DIR"; sed 's/failClosed/failOpen/g' "$GP/llm-judge.yaml" > "$FAILOPEN"
harness_up "$FAILOPEN" || { echo "could not start harness"; exit 1; }
harness_start_judge || { echo "could not start judge"; exit 1; }
harness_stop_judge
chat "What is the capital of France?"
assert_eq "failOpen: a clean request goes through when the judge is down" "200" "$HTTP"
assert_contains "  ...and reached the provider" "$(upstream_saw)" "capital of France"
chat "my ssn is 987-65-4321"
assert_eq "failOpen: built-in regex still rejects an SSN with the judge down (403)" "403" "$HTTP"
harness_save_log

echo
echo "latency (model: $JUDGE_MODEL, gateway webhook budget: fixed 10s): $RETRIED of $TOTAL judged cases needed a retry, $SLOW stayed over budget (SLOW)"
# A few SLOW cases are the known limit of a small local judge. More than a quarter means the
# judge is effectively unavailable (or the machine is overloaded) and the run is not valid.
if [ $((SLOW * 4)) -gt "$TOTAL" ]; then bad "too many cases over the gateway's 10s budget" "$SLOW of $TOTAL"; fi
echo "passed: $PASS   failed: $FAIL   slow: $SLOW"
[ "$FAIL" -eq 0 ]
