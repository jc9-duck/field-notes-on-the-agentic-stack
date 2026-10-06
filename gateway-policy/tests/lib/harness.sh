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

# Saved gateway log: appended to after each run, size-capped and rotated so it can never
# grow without bound. Total worst case is about (HARNESS_LOG_KEEP + 1) * HARNESS_LOG_MAX_KB
# plus one run's worth (~50 KB). The directory is gitignored: logs are never committed.
HARNESS_LOG_DIR="${HARNESS_LOG_DIR:-$_LIB/../out}"
HARNESS_LOG_MAX_KB="${HARNESS_LOG_MAX_KB:-5120}"
HARNESS_LOG_KEEP="${HARNESS_LOG_KEEP:-3}"
_LOG_FILE="$HARNESS_LOG_DIR/gateway-guardrails.log"

_rotate_log() {  # gateway-guardrails.log -> .1 -> .2 ... ; the oldest is dropped
  [ -f "$_LOG_FILE" ] || return 0
  local size i
  size=$(wc -c <"$_LOG_FILE" | tr -d ' ')
  [ "$size" -lt $((HARNESS_LOG_MAX_KB * 1024)) ] && return 0
  rm -f "$_LOG_FILE.$HARNESS_LOG_KEEP"
  i=$HARNESS_LOG_KEEP
  while [ "$i" -gt 1 ]; do
    [ -f "$_LOG_FILE.$((i - 1))" ] && mv "$_LOG_FILE.$((i - 1))" "$_LOG_FILE.$i"
    i=$((i - 1))
  done
  mv "$_LOG_FILE" "$_LOG_FILE.1"
}

# harness_save_log -- call BEFORE harness_down (which removes the container and its logs).
# Keeps only the gateway's per-request lines (status, guard, action, duration -- no request
# bodies, so no PII), not the startup config dump, which can echo keys. Readiness probes
# against /v1/models are dropped as noise.
harness_save_log() {
  docker inspect gp-gw >/dev/null 2>&1 || return 0
  mkdir -p "$HARNESS_LOG_DIR"
  _rotate_log
  {
    printf '# run %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${0##*/}"
    docker logs gp-gw 2>&1 | grep -E '[[:space:]]request gateway=' | grep -v 'http.path=/v1/models'
  } >>"$_LOG_FILE"
}

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
  docker rm -f gp-mock gp-gw gp-judge gp-nemo gp-nemo-adapter >/dev/null 2>&1
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

# ---- LLM judge (optional): gateway-policy/judge-webhook + Ollama on the host ----
JUDGE_MODEL="${JUDGE_MODEL:-llama3.1:8b}"
JUDGE_OLLAMA_URL="${JUDGE_OLLAMA_URL:-http://host.docker.internal:11434}"
JUDGE_PORT="${JUDGE_PORT:-19100}"

# Is Ollama up on this host with the judge model pulled? Tests skip (not fail) if not.
harness_ollama_ready() {
  curl -s -m 3 localhost:11434/api/tags | jq -e --arg m "$JUDGE_MODEL" '.models[] | select(.name == $m)' >/dev/null 2>&1
}

# Start the judge on the harness network, aliased `judge-webhook` to match the policy
# fragment. Waits until the model is warm (/ready): a cold load can take ~15s and the
# gateway only gives a webhook 10s. Call AFTER harness_up (which recreates the network).
harness_start_judge() {
  docker rm -f gp-judge >/dev/null 2>&1
  mkdir -p "$HARNESS_LOG_DIR"
  docker run -d --name gp-judge --network "$_NET" --network-alias judge-webhook \
    -p "$JUDGE_PORT":9100 \
    -v "$_LIB/../../judge-webhook:/app:ro" -v "$HARNESS_LOG_DIR:/logs" \
    -e OLLAMA_URL="$JUDGE_OLLAMA_URL" -e JUDGE_MODEL="$JUDGE_MODEL" -e LOG_DIR=/logs \
    "$MOCK_IMAGE" node /app/server.mjs >/dev/null || return 1
  for _ in $(seq 1 180); do
    curl -s -o /dev/null -m 2 -f "localhost:$JUDGE_PORT/ready" && return 0
    sleep 1
  done
  echo "judge did not become ready:" >&2; docker logs gp-judge 2>&1 | tail -10 >&2; return 1
}

harness_stop_judge() { docker stop gp-judge >/dev/null 2>&1; }

# ---- NeMo Guardrails (optional): gateway-policy/nemo, rails LLM = a Bedrock model ----
NEMO_RAILS_MODEL="${NEMO_RAILS_MODEL:-qwen.qwen3-coder-next}"
NEMO_ADAPTER_PORT="${NEMO_ADAPTER_PORT:-19200}"

# The rails call Bedrock with the bearer token from the environment (passed to the container
# by NAME, so the value never appears on a command line). Tests skip if it is not exported.
harness_bedrock_ready() { [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ]; }

# Start NeMo (built once from nemo/Dockerfile, pinned) with the rails config and the chosen
# Bedrock model, plus the adapter webhook aliased `nemo-adapter` to match the policy fragment.
# Call AFTER harness_up (which recreates the network).
harness_start_nemo() {
  docker image inspect gp-nemo >/dev/null 2>&1 || docker build -q -t gp-nemo "$_LIB/../../nemo" >/dev/null || return 1
  local cfg="$HARNESS_LOG_DIR/nemo-config"
  rm -rf "$cfg"; mkdir -p "$cfg"
  cp -R "$_LIB/../../nemo/config/gateway" "$cfg/gateway"
  # Swap the model on the `model:` line so other Bedrock models can be compared without editing the file.
  sed -i.bak "s|^\(    model: \).*|\1$NEMO_RAILS_MODEL|" "$cfg/gateway/config.yml"; rm -f "$cfg/gateway/config.yml.bak"
  docker rm -f gp-nemo gp-nemo-adapter >/dev/null 2>&1
  docker run -d --name gp-nemo --network "$_NET" --network-alias nemo \
    -e AWS_BEARER_TOKEN_BEDROCK -v "$cfg":/config gp-nemo >/dev/null || return 1
  docker run -d --name gp-nemo-adapter --network "$_NET" --network-alias nemo-adapter \
    -p "$NEMO_ADAPTER_PORT":9200 \
    -v "$_LIB/../../nemo/adapter:/app:ro" -v "$HARNESS_LOG_DIR:/logs" \
    -e NEMO_URL=http://nemo:8000 -e NEMO_MODEL="$NEMO_RAILS_MODEL" -e LOG_DIR=/logs \
    "$MOCK_IMAGE" node /app/server.mjs >/dev/null || return 1
  for _ in $(seq 1 120); do
    curl -s -o /dev/null -m 2 -f "localhost:$NEMO_ADAPTER_PORT/ready" && return 0
    sleep 1
  done
  echo "nemo did not become ready:" >&2; docker logs gp-nemo 2>&1 | tail -10 >&2; return 1
}

harness_stop_nemo() { docker stop gp-nemo-adapter gp-nemo >/dev/null 2>&1; }

# mock_next_reply <text> -- the mock's NEXT completion replies with this text (once), so a
# response-side case needs no trigger string in the prompt for a request-side guard to react to.
mock_next_reply() {
  jq -cn --arg t "$1" '{text:$t}' |
    docker exec -i gp-mock node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>fetch('http://localhost:9001/next',{method:'POST',body:b}))"
}
