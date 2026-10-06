#!/bin/bash
# End-to-end test of NVIDIA NeMo Guardrails as the LLM guardrail: a real agentgateway + mock
# provider + the nemo-adapter webhook + a NeMo server whose rails call a BEDROCK model.
#   B. built-in regex + NeMo -> the same 28 cases as the Ollama judge test
#   C. NeMo down             -> failClosed vs failOpen
# Same cases as test-judge-guardrails.sh, with one difference in what "caught" means: NeMo's
# self-check rails can only BLOCK, so a case the judge would mask (a street address, say) is
# expected to be rejected whole (HTTP 451) here.
#
# Needs: docker, curl, jq, and AWS_BEARER_TOKEN_BEDROCK exported (your Bedrock API key, the same
# one the repo's .env files hold). SKIPS (exit 0) without it. The first run builds the pinned
# NeMo image (a minute or two). Cost: one tiny Bedrock call per checked message.
# Run:  set -a; . agentgateway/.env; set +a; bash gateway-policy/tests/test-nemo-guardrails.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GP="$HERE/.."
CASES="$GP/fixtures/judge-cases.json"
# shellcheck source=lib/harness.sh
source "$HERE/lib/harness.sh"

if ! harness_bedrock_ready; then
  echo "SKIP: AWS_BEARER_TOKEN_BEDROCK is not exported (NeMo's rails call a Bedrock model)"
  exit 0
fi

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n        %s\n' "$1" "$2"; }
assert_eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected [$2] got [$3]"; }
assert_contains() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "expected to contain [$3] in [$2]";; esac; }

trap 'harness_save_log; harness_down' EXIT

case_field() { jq -r --arg id "$1" ".[] | select(.id == \$id) | $2" "$CASES"; }
case_text() {
  local t; t=$(case_field "$1" '.text // empty')
  if [ -z "$t" ]; then t=$(cat "$GP/fixtures/$(case_field "$1" '.text_file')"); fi
  printf '%s' "$t"
}

echo "== validating policy"
assert_eq "NeMo policy validates" "Configuration is valid!" "$(harness_validate "$GP/llm-nemo.yaml")"

echo "== B. built-in regex + NeMo Guardrails (rails model: $NEMO_RAILS_MODEL on Bedrock)"
rm -f "$HARNESS_LOG_DIR/nemo-verdicts.jsonl" "$HARNESS_LOG_DIR/nemo-verdicts.jsonl.1"
harness_up "$GP/llm-nemo.yaml" || { echo "could not start harness"; exit 1; }
harness_start_nemo || { echo "could not start NeMo"; exit 1; }
for id in $(jq -r '.[].id' "$CASES"); do
  dir=$(case_field "$id" '.direction'); expect=$(case_field "$id" '.expect'); text=$(case_text "$id")
  if [ "$dir" = "response" ]; then
    mock_next_reply "$text"
    chat "Please summarize the open support ticket."
  else
    chat "$text"
  fi
  case "$expect" in
    reject|mask)
      assert_eq "$id: NeMo blocks it (451)" "451" "$HTTP"
      [ "$HTTP" = "451" ] && assert_contains "  ...with NeMo's message" "$BODY" "NeMo Guardrails"
      ;;
    pass)
      assert_eq "$id: ($dir) passes" "200" "$HTTP"
      ;;
  esac
done

echo "== verdict log (decisions only, never the text)"
VLOG="$HARNESS_LOG_DIR/nemo-verdicts.jsonl"
if [ -f "$VLOG" ]; then
  assert_contains "log records a reject" "$(cat "$VLOG")" '"action":"reject"'
  assert_contains "log records a pass"   "$(cat "$VLOG")" '"action":"pass"'
  leak=""
  for s in "20 Ingram Street" "000123456701" "GB82 WEST" "2223 0031" "Tr0ub4dor" "tok_demo_" "Ignore all previous"; do
    grep -q -F "$s" "$VLOG" && leak="$leak [$s]"
  done
  assert_eq "log contains no request or response text" "" "$leak"
  echo "        latency of NeMo checks (ms): $(jq -s '[.[] | select(.checked > 0) | .ms] | sort | "median \(.[length/2|floor]), max \(.[-1]), n=\(length)"' "$VLOG")"
else
  bad "nemo verdict log exists" "no $VLOG"
fi
harness_save_log

echo "== C. NeMo unavailable: failClosed vs failOpen"
harness_stop_nemo
chat "What is the capital of France?"
echo "        (observed with failClosed and NeMo down: HTTP $HTTP)"
[ "$HTTP" != "200" ] && ok "failClosed: a clean request is NOT let through when NeMo is down" || bad "failClosed blocks when NeMo is down" "got HTTP 200"
harness_save_log

FAILOPEN="$HARNESS_LOG_DIR/llm-nemo-failopen.yaml"
sed 's/failClosed/failOpen/g' "$GP/llm-nemo.yaml" > "$FAILOPEN"
harness_up "$FAILOPEN" || { echo "could not start harness"; exit 1; }
harness_start_nemo || { echo "could not start NeMo"; exit 1; }
harness_stop_nemo
chat "What is the capital of France?"
assert_eq "failOpen: a clean request goes through when NeMo is down" "200" "$HTTP"
chat "my ssn is 987-65-4321"
assert_eq "failOpen: built-in regex still rejects an SSN with NeMo down (403)" "403" "$HTTP"
harness_save_log

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
