# NeMo Guardrails behind agentgateway

NVIDIA NeMo Guardrails as a second LLM guardrail, using a **Bedrock** model for its rails. It sits
behind the same webhook contract as the Ollama judge (`../judge-webhook`), so the two are
interchangeable and can be compared on the same 28 labeled cases.

```
agentgateway --POST /request--> nemo-adapter --POST /v1/checks--> NeMo server --OpenAI-compatible--> Bedrock
     ^----------POST /response---------'                              (self check input / output rails)
```

## Pieces

| Path | What it is |
| --- | --- |
| `Dockerfile` | Pinned `nemoguardrails[server]==0.24.1` on `python:3.12-slim` (NVIDIA publishes no image) |
| `config/gateway/config.yml`, `prompts.yml` | The rails as code: `self check input` + `self check output`, Bedrock model, policy prompts |
| `adapter/` | Dependency-free Node webhook: gateway `/request` and `/response` -> NeMo `POST /v1/checks` -> pass / mask / reject |
| `calibrate.mjs` | Run the 28 cases straight through a NeMo server and score them |
| `../llm-nemo.yaml` | The gateway policy: built-in regex, then the NeMo webhook (`failClosed`) |
| `../tests/test-nemo-guardrails.sh` | End to end through a real gateway; skips without `AWS_BEARER_TOKEN_BEDROCK` |

## How it maps

NeMo's check API returns `passed` / `modified` / `blocked`: pass, mask (use NeMo's rewritten
content), reject (HTTP **451**, regex rejects are 403). Only `user` turns are checked on the way in,
and the cleaned view of earlier placeholders (see below) is what NeMo reads.

## Verified (NeMo v0.24.1, measured here)

- **Same Bedrock call.** NeMo's `engine: openai` + `parameters.base_url` reaches Bedrock's
  OpenAI-compatible endpoint with the same bearer token switchyard uses. No extra credential, no NVIDIA key.
- **`model` in the request overrides the config.** `POST /v1/checks` takes the model from the request
  body; a placeholder id is rejected by Bedrock. The adapter sends the real id every time.
- **Model choice decides everything.**

| Bedrock model | Accuracy (28 cases) | Median | Notes |
| --- | --- | --- | --- |
| `qwen.qwen3-coder-next` (default) | 28/28 | ~0.6 s | max ~4 s |
| `zai.glm-5` | 27/28 | ~0.8 s | missed the street address |
| `openai.gpt-oss-20b-1:0` | 16/28 | ~1 s | blocks 12 harmless cases |

  `gpt-oss` is a reasoning model: its output breaks the yes/no parsing, and NeMo treats unparseable
  output as unsafe and blocks. NeMo's docs warn about exactly this.
- **Latency is not the problem it was for the local judge.** Through the gateway: median ~0.7 s, max
  ~3.2 s, against the gateway's fixed 10 s webhook budget. The rail's answer is a couple of tokens
  ("yes" / "no"), where the Ollama judge generates span lists at ~16 tokens/s.
- **Placeholders again.** The built-in phone regex turns `build 2026.10.04-117` into `<PHONE_NUMBER>`;
  NeMo's output rail then blocked the garbled sentence (the same trap the Ollama judge hit). NeMo reads
  a cleaned view (`[removed] `) and the forwarded text is untouched.

## Differences from the Ollama judge (read before choosing)

- **Block, not mask.** Self-check rails can only block. A message with a street address is rejected
  whole (451); the judge masks just the span and lets the rest through. NeMo does have masking rails
  (a GLiNER PII model), but those call NVIDIA's hosted endpoint, not Bedrock, and were not tried here.
- **Privacy.** The judge runs on your machine; here the text being checked, PII included, goes to your
  Bedrock account. For a guardrail whose job is to see sensitive data, that is a real tradeoff.
- **Cost and availability.** One small Bedrock call per checked message. With `failClosed`, a Bedrock
  outage blocks traffic (verified: HTTP 503); `failOpen` lets it through (and regex still rejects SSNs).
- **Tool results.** The check API does not run tool rails, and agentgateway v1.5.0 does not send tool
  results to webhooks at all, so the tool-result gap is unchanged.

## Caveats on the numbers

- The policy prompts (`prompts.yml`) reuse wording from the judge prompt, including its note about
  everyday "ignore"/"disregard", so those two pass cases are not independent. The 7 cases held out from
  prompt design also passed on the default model.
- 28 hand-made, synthetic cases is a small set. Treat it as a smoke test, not a benchmark.

## Run it

```bash
node --test gateway-policy/nemo/adapter/adapter.test.mjs          # unit tests, no NeMo, no Bedrock

# Compare Bedrock models directly (needs a running NeMo server on :18000):
docker build -t gp-nemo gateway-policy/nemo
BEDROCK_RAILS_MODEL=zai.glm-5 node gateway-policy/nemo/calibrate.mjs

# End to end through a real gateway:
set -a; . agentgateway/.env; set +a        # exports AWS_BEARER_TOKEN_BEDROCK
bash gateway-policy/tests/test-nemo-guardrails.sh
NEMO_RAILS_MODEL=zai.glm-5 bash gateway-policy/tests/test-nemo-guardrails.sh   # try another model
```
