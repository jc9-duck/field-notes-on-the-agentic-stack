#!/usr/bin/env bash
# Proves routes.vision (the manual-switch image-capable passthrough route in
# routes.toml) actually reads image content, not just text — and that pi
# itself can drive it end to end, not only raw HTTP.
#
# routes.vision is deliberately NOT part of routes.smart-v2's classifier: it's
# a model you switch to on purpose when you have an image/screenshot to hand
# it, not something the router auto-picks.
#
# Two checks, same target, two paths:
#   1. Direct curl through Switchyard's /v1/chat/completions — proves the
#      target/route wiring and that the underlying model reads the image.
#   2. `pi --no-tools --provider switchyard --model vision` — proves the
#      actual user-facing path. --no-tools is required here: calling this
#      route from a normal pi session (full tool-schema system prompt) hits
#      an upstream vLLM bug in NVIDIA's Llama-3.2-Vision (mllama) deployment
#      -- "The number of image tokens (0) must be the same as the number of
#      images (1)" -- caused by pi's large system prompt confusing the
#      model's image-placeholder counting. Not a Switchyard or config bug;
#      see tests/README.md.
#
# Run from inside the pi container (needs switchyard-server on
# 127.0.0.1:4000, jq, and python3, all already baked into the image):
#   docker compose exec pi bash tests/test-vision-route.sh
# or, for a one-off container:
#   docker compose run --rm pi bash tests/test-vision-route.sh
set -uo pipefail

SWITCHYARD_URL="http://127.0.0.1:4000/v1/chat/completions"
EXPECTED_MODEL="meta/llama-3.2-11b-vision-instruct"
IMG_PATH="/tmp/vision-route-test.png"

pass_count=0
fail_count=0

pass() { echo "PASS  [$1]"; pass_count=$((pass_count + 1)); }
fail() { echo "FAIL  [$1] $2"; fail_count=$((fail_count + 1)); }

# Solid red 64x64 PNG, built without any image library dependency.
python3 -c '
import struct, zlib

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

w, h = 64, 64
sig = b"\x89PNG\r\n\x1a\n"
ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
raw = b"".join(b"\x00" + bytes((220, 20, 20)) * w for _ in range(h))
idat = chunk(b"IDAT", zlib.compress(raw))
iend = chunk(b"IEND", b"")

with open("'"$IMG_PATH"'", "wb") as f:
    f.write(sig + ihdr + idat + iend)
'

# --- Check 1: direct curl through Switchyard ---
img_b64=$(base64 -w0 "$IMG_PATH")
body=$(curl -s "$SWITCHYARD_URL" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg img "data:image/png;base64,$img_b64" '{
    model: "vision",
    messages: [{role: "user", content: [
      {type: "text", text: "What color is this image? Answer with exactly one word."},
      {type: "image_url", image_url: {url: $img}}
    ]}],
    max_tokens: 20
  }')")

actual_model=$(echo "$body" | jq -r '.model // empty')
actual_content=$(echo "$body" | jq -r '.choices[0].message.content // empty')

if [[ "$actual_model" == "$EXPECTED_MODEL" && "$actual_content" =~ [Rr]ed ]]; then
  pass "curl direct -> $actual_model said '$actual_content'"
else
  fail "curl direct" "expected model=$EXPECTED_MODEL content~=red, got model=${actual_model:-<none>} content=${actual_content:-<none>}. response: $(echo "$body" | head -c 300)"
fi

# --- Check 2: through pi itself, --no-tools ---
pi_output=$(pi --no-tools --provider switchyard --model vision \
  -p "What color is this image? Answer with exactly one word." "@$IMG_PATH" 2>&1)

if [[ "$pi_output" =~ [Rr]ed ]]; then
  pass "pi --no-tools -> '$pi_output'"
else
  fail "pi --no-tools" "expected output containing 'red', got: $pi_output"
fi

echo
echo "$pass_count passed, $fail_count failed"
[[ "$fail_count" -eq 0 ]]
