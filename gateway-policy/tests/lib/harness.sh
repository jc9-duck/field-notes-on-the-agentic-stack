#!/bin/bash
# Shared test harness: brings up the mock upstream + agentgateway (LLM listener only)
# on a private docker network, using a policy fragment from gateway-policy/.
#
#   source lib/harness.sh
#   harness_up ../llm-guardrails.yaml     # fragment = the `llm.policies` subtree
#   chat "some prompt"                    # sets $HTTP and $BODY
#   upstream_saw                          # what the gateway forwarded, as text
#   harness_down
#
# The gateway config is passed as bytes (-c), not a bind mount, so this works from any
# checkout path and needs no Docker file-sharing setup.

AGW_IMAGE="${AGW_IMAGE:-cr.agentgateway.dev/agentgateway:v1.5.0}"
MOCK_IMAGE="${MOCK_IMAGE:-node:22-alpine}"
HARNESS_PORT="${HARNESS_PORT:-14100}"
_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_NET=gp-test-net

harness_config() {  # $1 = fragment path
  cat <<EOF
llm:
  port: 4100
  models:
    - name: "*"
      provider: openAI
      params:
        apiKey: "test"
        hostOverride: gp-mock:9001
EOF
  cat "$1"
}

harness_validate() {  # $1 = fragment path
  docker run --rm "$AGW_IMAGE" -c "$(harness_config "$1")" --validate-only 2>&1 | tail -5
}

harness_down() {
  docker rm -f gp-mock gp-gw >/dev/null 2>&1
  docker network rm "$_NET" >/dev/null 2>&1
}

harness_up() {  # $1 = fragment path
  harness_down
  docker network create "$_NET" >/dev/null
  docker run -d --name gp-mock --network "$_NET" "$MOCK_IMAGE" node -e "$(cat "$_LIB/mock-upstream.mjs")" >/dev/null
  docker run -d --name gp-gw --network "$_NET" -p "$HARNESS_PORT":4100 "$AGW_IMAGE" -c "$(harness_config "$1")" >/dev/null
  for _ in $(seq 1 30); do
    curl -s -o /dev/null -m 2 "localhost:$HARNESS_PORT/v1/models" && return 0
    sleep 0.5
  done
  echo "gateway did not come up:" >&2; docker logs gp-gw 2>&1 | tail -15 >&2; return 1
}

# chat <user text>  -> sets HTTP (status code) and BODY (response body)
chat() {
  local payload
  payload=$(jq -cn --arg c "$1" '{model:"gpt-test",messages:[{role:"user",content:$c}]}')
  local out
  out=$(curl -s -m 30 -w '\n%{http_code}' "localhost:$HARNESS_PORT/v1/chat/completions" \
        -H 'content-type: application/json' -d "$payload")
  HTTP="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# chat_messages '<json array of messages>'  -> sets HTTP and BODY (for tool-call turns)
chat_messages() {
  local payload
  payload=$(jq -cn --argjson m "$1" '{model:"gpt-test",messages:$m}')
  local out
  out=$(curl -s -m 30 -w '\n%{http_code}' "localhost:$HARNESS_PORT/v1/chat/completions" \
        -H 'content-type: application/json' -d "$payload")
  HTTP="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# upstream_saw_tool -> the last tool message content the mock received
upstream_saw_tool() {
  docker exec gp-mock node -e "fetch('http://localhost:9001/last').then(r=>r.json()).then(j=>{const u=[...(j&&j.messages||[])].reverse().find(m=>m.role==='tool');process.stdout.write(u?String(u.content):'')})"
}

# upstream_saw -> the last user message content the mock received
upstream_saw() {
  docker exec gp-mock node -e "fetch('http://localhost:9001/last').then(r=>r.json()).then(j=>{const u=[...(j&&j.messages||[])].reverse().find(m=>m.role==='user');process.stdout.write(u?String(u.content):'')})"
}

# assistant_said -> assistant text from the last BODY
assistant_said() { printf '%s' "$BODY" | jq -r '.choices[0].message.content // empty' 2>/dev/null; }
