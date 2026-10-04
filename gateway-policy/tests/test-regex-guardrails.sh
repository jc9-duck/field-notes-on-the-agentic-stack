#!/bin/bash
# End-to-end test of gateway-policy/llm-guardrails.yaml (regex guardrails).
# Brings up a real agentgateway + mock upstream, replays the synthetic PII fixtures,
# and asserts on what the client got back and what the "provider" actually received.
# Needs: docker, curl, jq.      Run:  bash gateway-policy/tests/test-regex-guardrails.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
POLICY="$HERE/../llm-guardrails.yaml"
FIX="$HERE/../fixtures"
# shellcheck source=lib/harness.sh
source "$HERE/lib/harness.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n        %s\n' "$1" "$2"; }
# assert_eq <name> <expected> <actual>
assert_eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected [$2] got [$3]"; }
# assert_contains / assert_lacks <name> <haystack> <needle>
assert_contains() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "expected to contain [$3] in [$2]";; esac; }
assert_lacks()    { case "$2" in *"$3"*) bad "$1" "must not contain [$3] in [$2]";; *) ok "$1";; esac; }

trap harness_down EXIT
echo "== validating policy"
V=$(harness_validate "$POLICY"); assert_eq "config validates" "Configuration is valid!" "$V"
echo "== starting gateway + mock upstream"
harness_up "$POLICY" || { echo "could not start harness"; exit 1; }

# people.csv columns: id name street city phone email ssn card expiry routing account
echo "== hard stops (reject -> 403, nothing reaches the provider)"
while IFS=, read -r id name street city phone email ssn card exp routing account; do
  chat "Verify $name, SSN $ssn"
  assert_eq "SSN rejected: $name ($ssn)" "403" "$HTTP"
  chat "Charge card $card please"
  assert_eq "card rejected: $name ($card)" "403" "$HTTP"
done < <(tail -n +2 "$FIX/people.csv")

echo "== redactions (200, provider sees placeholder, never the value)"
while IFS=, read -r id name street city phone email ssn card exp routing account; do
  chat "Contact $name at $email"
  saw=$(upstream_saw)
  assert_eq "email forwarded masked: $name" "200" "$HTTP"
  assert_lacks "email value withheld: $name" "$saw" "$email"
  assert_contains "email placeholder present: $name" "$saw" "<EMAIL_ADDRESS>"

  chat "Call $name on $phone tomorrow"
  saw=$(upstream_saw)
  assert_lacks "phone value withheld: $name ($phone)" "$saw" "$phone"
  assert_contains "phone placeholder present: $name" "$saw" "<masked>"

  chat "$name lives at $street, $city"
  saw=$(upstream_saw)
  assert_lacks "street address withheld: $name ($street)" "$saw" "$street"

  chat "Refund to account number $account"
  saw=$(upstream_saw)
  assert_lacks "account number withheld: $name" "$saw" "$account"
done < <(tail -n +2 "$FIX/people.csv")

echo "== IBAN and routing number"
chat "IBAN GB82 WEST 1234 5698 7654 32 for the refund"
assert_lacks "IBAN withheld" "$(upstream_saw)" "GB82 WEST 1234 5698 7654 32"
chat "routing number 123456780"
assert_eq "bare 9-digit routing number rejected (ssn builtin)" "403" "$HTTP"

echo "== free-text document with PII (support-ticket.txt)"
chat "$(cat "$FIX/support-ticket.txt")"
assert_eq "ticket with SSN+card rejected" "403" "$HTTP"
# Same ticket with the hard-stop values removed: the rest must come through redacted.
STRIPPED=$(sed -E 's/987-65-43[0-9]{2}/[removed]/g; s/[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}/[removed]/g; s/routing number 123456780/routing number [removed]/' "$FIX/support-ticket.txt")
chat "$STRIPPED"
saw=$(upstream_saw)
assert_eq "stripped ticket accepted" "200" "$HTTP"
for leak in "bruce.wayne@example.com" "peter.parker@example.com" "(212) 555-0102" "212-555-0101" \
            "1007 Mountain Drive" "000123456702" "GB82 WEST"; do
  assert_lacks "ticket redacted: $leak" "$saw" "$leak"
done
assert_contains "ticket prose preserved" "$saw" "Charge on my card I don't recognise"

echo "== false positives (clean control must pass untouched)"
CLEAN=$(cat "$FIX/clean-control.txt")
chat "$CLEAN"
assert_eq "clean doc accepted" "200" "$HTTP"
assert_eq "clean doc forwarded byte-for-byte" "$CLEAN" "$(upstream_saw)"

echo "== response guard (provider output is masked on the way back)"
REPLY="Reach Peter at peter.parker@example.com or (212) 555-0101, SSN 987-65-4321, card 4242 4242 4242 4242."
chat "RESPOND_B64:$(printf '%s' "$REPLY" | base64 | tr -d '\n')"
said=$(assistant_said)
assert_eq "response status" "200" "$HTTP"
for leak in "peter.parker@example.com" "(212) 555-0101" "987-65-4321" "4242 4242 4242 4242"; do
  assert_lacks "response masked: $leak" "$said" "$leak"
done
assert_contains "response prose preserved" "$said" "Reach Peter at"

echo "== tool results (what pi feeds back after an MCP/GitHub tool call)"
chat_messages '[{"role":"user","content":"look up the customer"},{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"c1","content":"Customer SSN 987-65-4321"}]'
TOOL_SSN_HTTP="$HTTP"
chat_messages '[{"role":"user","content":"look up the customer"},{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"c1","content":"Email is peter.parker@example.com"}]'
TOOL_SAW="$(upstream_saw_tool)"
# KNOWN GAP, pinned: agentgateway v1.5.0 guardrails only inspect user/system/assistant
# message text -- role:"tool" content is NOT scanned, so PII inside tool results (e.g.
# GitHub or docs tool output pi feeds back to the model) reaches the provider. Newer
# agentgateway docs describe a `scope: [toolOutput]` option the pinned schema rejects.
# These two assertions are deliberately "the gap exists": when a version bump closes it
# they will fail, which is the cue to turn them into 403/masked assertions.
assert_eq "KNOWN GAP: tool-result SSN not rejected (v1.5.0)" "200" "$TOOL_SSN_HTTP"
assert_contains "KNOWN GAP: tool-result email reaches provider unmasked (v1.5.0)" "$TOOL_SAW" "peter.parker@example.com"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
