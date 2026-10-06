# judge-webhook

An agentgateway guardrail webhook backed by a local LLM (Ollama). It catches what regex
can't express, in both directions. Dependency-free Node (`node:http`), no build step.

```
pi -> switchyard -> agentgateway --POST /request--> judge-webhook --> Ollama (host)
                         |  <----------POST /response------------'
                         v
                      provider
```

## What it does

| Direction | Catches | Action |
| --- | --- | --- |
| request (`POST /request`) | prompt injection / jailbreak, including instructions hidden in a pasted document | **reject**, HTTP 451 |
| request | street address, bank account, IBAN, Mastercard 2-series and other cards, passwords, tokens that regex missed | **mask** the span: `<REDACTED:ADDRESS>` etc. |
| response (`POST /response`) | secrets, credentials and PII the model is about to send back | **mask** the span |

Judge rejects return **451**, regex rejects return **403**, so you can tell which layer caught
something.

## Design

- **The model identifies, code redacts.** The judge returns *verbatim substrings*; `applySpans()`
  replaces them only if they appear in the text. A hallucinated span changes nothing and the
  model never rewrites a message. Spans that are plain words (the model flagging the word
  "password"), too short, or already a placeholder are dropped in code.
- **Only `user` messages are judged on the way in.** `system` is the client's trusted
  instructions (pi's is huge), `assistant` turns were already judged as responses, and
  agentgateway v1.5.0 does not send tool results to webhooks at all (the known gap).
- **Cached by content hash.** Clients resend the whole conversation every turn.
- **The judge reads a cleaned view** of text that earlier guards already redacted
  (`<PHONE_NUMBER>` becomes `[removed] `). Measured: glued placeholders made the model invent
  spans and take ~8s; the cleaned view answers in 2-3s. The forwarded text is never altered by this.
- **Verdict log** (`judge-verdicts.jsonl`, optional via `LOG_DIR`): decision, category names,
  counts, timing. **Never the text or the spans**, because the spans are the PII.
- **Wire format** (agentgateway v1.5.0, verified in its source and against a live probe):
  request `{"body":{"messages":[{role,content}]}}`, response
  `{"body":{"choices":[{"message":{role,content}}]}}`. Reply `{"action":{...}}` as pass
  (`{"reason"}`), mask (`{"body":<same shape>}`) or reject (`{"body":"...","status_code":N}`).

## The honest limitation: latency

agentgateway gives a webhook a **fixed 10 seconds** (not configurable in v1.5.0). A local judge
generates ~16 tokens/s on an M2 with `llama3.1:8b`, so a verdict with several spans takes
5-10s and some exceed the budget. With `failureMode: failClosed` those requests are rejected
(503) rather than let through unguarded.

Measured on this repo's 28 labeled cases (`fixtures/judge-cases.json`):

| Model | Accuracy | Median | Notes |
| --- | --- | --- | --- |
| `llama3.1:8b` (default) | 28/28 | ~3-4 s | multi-span cases reach 8-11 s |
| `qwen2.5:14b` | 27/27 (earlier 27-case set) | ~8 s, max 28 s | too slow for a 10 s budget |
| `llama3.2:3b` | 25/28 | ~1.4 s | missed an account number, a persona-style injection and a private key |

In the end-to-end test through the gateway, 4 of 28 cases (14%) stayed over budget on the
8B model and failed closed. Options: a faster machine, a smaller model (accuracy cost, above),
or `failOpen` (availability over safety). The e2e test reports these as `SLOW`, never as a pass.

Two things that look like free speedups but are not (both measured worse): dropping the
`reason` field, and putting `prompt_injection` before `sensitive` in the schema. The model fills
keys in declared order, and listing spans then a short reason before the verdict is what keeps
it accurate.

## Run it

```bash
node --test gateway-policy/judge-webhook/judge.test.mjs     # unit tests, no Ollama
cd gateway-policy/judge-webhook && node calibrate.mjs       # 28 labeled cases straight through the judge
JUDGE_MODEL=llama3.2:3b node calibrate.mjs                  # compare models

PORT=9100 OLLAMA_URL=http://localhost:11434 JUDGE_MODEL=llama3.1:8b LOG_DIR=/tmp/judge node server.mjs
curl localhost:9100/ready    # 200 once the model is warm (a cold load can take ~15 s)
```

End to end through a real gateway (needs Docker and Ollama with the model pulled; skips cleanly
if Ollama is missing): `bash gateway-policy/tests/test-judge-guardrails.sh`.

Env: `PORT` (9100), `OLLAMA_URL` (`http://host.docker.internal:11434`), `JUDGE_MODEL`
(`llama3.1:8b`), `JUDGE_DEADLINE_MS` (9000, below the gateway's 10 s), `LOG_DIR` (unset = stdout only).
