# Plan: agentgateway guardrails, managed as code (pi-first)

## Context
Next post in the "Field Notes on the Agentic Stack" series: guardrails on the
agentgateway. Because the gateway is a proxy that terminates the client connection and
opens a fresh TLS connection upstream, it sees plaintext payloads and can inspect, mask
or reject them. Two guardrail kinds: **deterministic** (built-in + custom regex) and
**non-deterministic** (an LLM judge wired in via a custom webhook). Last post said
production would manage this as infrastructure as code, so this post makes that real:
policy lives in its own folder, reviewed via PR, validated in CI, covered by tests, with
screenshots as evidence.

Scope: **pi only** (the series' agent). Claude Code / Codex etc. are a later follow-up.

## Findings that shape the design
- agentgateway guardrails apply to **LLM traffic only** (completions/messages/responses),
  not MCP tool calls. Our current `mcp:` config on :4000 won't use them.
- Config: `llm.policies.guardrails` (shared) and `llm.models[].guardrails` (per model);
  `request`/`response` lists; `regex` (`builtin`: email, phoneNumber, ssn, creditCard,
  caSin, or custom `pattern`; actions `reject`/`mask`/`audit`), `webhook`
  (`POST /request`, `POST /response`, 10s timeout, `failureMode` failClosed/failOpen),
  plus moderation / Bedrock / Azure / Model Armor providers. Order: regex -> moderation
  -> webhook; stops on reject. `scope: [messages, toolOutput]` lets tool results
  (e.g. GitHub output) be scanned when they flow back into the next LLM request.
- Path: pi -> switchyard -> **agentgateway `llm:`** -> provider, by pointing
  switchyard `routes.toml` `base_url`s at agentgateway. Plaintext on the compose network.
- UNVERIFIED: whether `mcp:` and `llm:` can coexist in one agentgateway v1.5.0 config;
  webhook JSON contract (docs fetched didn't include it). Both are step 0 spikes.
- Local models available: llama3.1:8b, qwen2.5:14b (Ollama on host).

## Decisions (defaults; flag if wrong)
- New top-level folder **`gateway-policy/`**: single source of truth for agentgateway
  policy only. Old folders stay frozen snapshots (CLAUDE.md convention); data-plane
  duplication (switchyard/trace/failover) is NOT refactored.
- New runnable demo folder **`guardrails/`**: copy-and-extend of `agentgateway/`, shifted
  ports so it can run alongside `agentgateway/` and `mcp/`; consumes the assembled
  config from `gateway-policy/`.
- LLM judge: **local Ollama behind a small webhook service** (free, private, series
  "zero dollars" bar). Bedrock Guardrails is a possible follow-up comparison.
- Folder in this repo, not a separate repo (revisit if it needs its own release cycle).

## Steps (each = issue -> worktree branch -> PR; no merge without go-ahead)
0. **Spike** (throwaway, not committed): run agentgateway v1.5.0 with `llm:` guardrails;
   confirm mcp+llm coexistence (else run a second agentgateway instance for LLM), the
   webhook request/response contract (`--help`/source/probing a logging webhook), and
   whether a `--validate-only`-style flag exists for CI.
1. **`gateway-policy/` skeleton**: fragments by concern (`targets.yaml`,
   `mcp-policy.yaml`, `llm-guardrails.yaml`), `assemble.sh` producing `config.yaml`,
   README. Port current `agentgateway/config.yaml` content (incl. read-only GitHub rule
   from PR #47) so behaviour is identical before adding guardrails.
2. **Deterministic guardrails**: regex request guards (reject SSN/credit card; mask
   email/phone), response mask, `scope` incl. `toolOutput`. Pin everything.
3. **LLM-judge webhook**: `gateway-policy/judge-webhook/` (tiny dependency-free Node
   service, same style as `docs-server`'s `log-call.mjs` JSONL logging) implementing
   `/request` and `/response`; calls Ollama with a JSON-schema-constrained verdict
   (prompt injection, jailbreak, policy topics regex can't catch). Explicit
   `failureMode` choice, documented. Logs verdicts to `logs/` for screenshots.
4. **`guardrails/` demo folder**: copy of `agentgateway/` wired through the gateway
   (switchyard `base_url` -> agentgateway llm port), shifted ports, `dev.sh`, README
   walkthrough with deep links, `.env` symlink convention (never print values).
5. **Tests** (`gateway-policy/tests/*.sh`, end-to-end against running containers, assert
   on real responses, per repo pattern): SSN rejected; card number rejected; email
   masked in request and response; clean prompt passes; prompt injection caught by
   judge but NOT by regex (the "why you need both" case); webhook down -> expected
   fail-open/closed behaviour; GitHub tool output with a planted secret masked.
6. **CI**: add assembled-config validation + tests-that-can-run-without-Ollama to a
   workflow; keep gitleaks; add `guardrails` to the Trivy matrix.
7. **Evidence + post**: screenshots (rejected request in pi, masked payload in trace /
   judge log, agentgateway console policy view), `posts/architecture.md` dated entry
   (append only), post draft into `_working/linkedin-notes.md`, root README + CLAUDE.md
   folder list updated.

## Critical files
- `agentgateway/config.yaml`, `agentgateway/docker-compose.yml`, `agentgateway/routes.toml`
  (sources to copy/extend; not modified)
- new: `gateway-policy/**`, `guardrails/**`, `.github/workflows/security-scan.yml` (matrix)
- reuse: `agentgateway/docs-server/log-call.mjs` pattern, `mcp-trace-server.mjs` viewer
  style, `mcp/tests/*.sh` test pattern, `dev.sh` (`--service-ports`)

## Verification
- `gateway-policy/assemble.sh` output diffs clean against expected; config validates.
- `docker compose up` in `guardrails/`; run the step 5 test scripts; all assertions pass.
- Manual: in pi, send an SSN prompt (blocked), an injection prompt (judge blocks),
  a clean prompt (passes); confirm in judge log and agentgateway console.
- CI green; gitleaks clean; no secret values in logs or screenshots.

## Open risks
- mcp+llm coexistence may force two gateway instances (changes step 4 topology).
- 8B local judge is slow/imprecise; tests for the judge must tolerate that (low
  temperature, schema-constrained output, a small curated case set).
- Streaming responses may limit response-side guardrails (undocumented; spike).
- Prior Bedrock key exposure in an old transcript: rotate before screenshots.

## Spike results (step 0, 2026-10-04, agentgateway v1.5.0)
Run against a mock OpenAI upstream + logging webhook; throwaway, not committed.
- **mcp + llm coexist in one config.** Both `bind/4000` (mcp) and `bind/4100` (llm)
  start from one file; no second instance needed. Step 4 topology stays single-gateway.
- **`--validate-only` exists** -> usable as the CI config check (step 6).
- **Regex:** `reject` -> HTTP 403 "The request was rejected due to inappropriate
  content"; `mask` rewrites in place (`<EMAIL_ADDRESS>`, `<PHONE_NUMBER>`), on both
  request and response.
- **Order:** guards run in listed order; the webhook sees content already masked by
  earlier regex guards.
- **Webhook contract (observed):** `POST /request` with body
  `{"body":{"messages":[{role,content},...]}}`, no auth header unless configured.
  Reply `{"action":{"type":"pass"}}`; `{"action":{"type":"reject","body":"...",
  "status_code":451,"reason":"..."}}` -> client gets that status/body;
  `{"action":{"type":"mask","body":{"messages":[...]},"reason":"..."}}` -> upstream
  receives the rewritten messages.
- **Observability for free:** the request log line carries
  `agw.ai.guardrails=[{"phase","guard","action"}]` -- source for screenshots and
  test assertions.
- **Config gotchas:** upstream override is `params.hostOverride` (not a model-level
  field); `provider: openAI` model entries; guards live under
  `llm.models[].guardrails.{request,response}`.
- **Not yet verified:** streaming responses with response guards; the `/response`
  webhook payload shape; `scope: toolOutput` behaviour; real provider wiring
  (Ollama/Bedrock/NVIDIA via OpenAI-compatible). Docker could not bind-mount the
  scratchpad (used `-c` config bytes) -- irrelevant for repo folders.

## Step 3 results (LLM judge, 2026-10-05, agentgateway v1.5.0)
Built and measured in `judge-webhook/` (design and numbers in its README). Resolves the spike
items above that were marked not verified:
- **`/response` payload:** `{"body":{"choices":[{"message":{"role","content"}}]}}`. Webhook
  replies may `pass`, `mask` (`{"body":{"choices":[...]}}`) or `reject` on the response side too
  (unlike regex, where response matches are always masked). Source: `llm/policy/webhook.rs`.
- **Config:** `webhook: {target: {host: name:port}, failureMode: failClosed|failOpen}`.
- **The gateway gives a webhook a fixed 10 s** (`with_default_timeout`, not configurable). That is the
  binding constraint: a local `llama3.1:8b` judge (~16 tok/s on an M2) takes 2-11 s, and in the e2e run
  4 of 28 cases (14%) exceeded it and failed closed. `qwen2.5:14b` is too slow; `llama3.2:3b` is
  3x faster but missed 3 of 28.
- **Layering interaction:** the built-in `phoneNumber` regex mangles part numbers and build strings
  into `<PHONE_NUMBER>`; the judge then saw garbled text, invented spans and took ~8 s. Fixed by
  giving the judge a cleaned view (`[removed] `) and never re-redacting a placeholder.
- **Still not verified:** streaming responses with response guards; `scope: toolOutput`; real
  provider wiring through `llm:` (step 4). The gateway source also contains MCP guardrail code
  (`mcp/guardrails`); whether it exists in v1.5.0 is untested and worth checking for the
  tool-result gap.

## NeMo Guardrails results (2026-10-06, NeMo v0.24.1, Bedrock rails model)
Built in `nemo/` (design, numbers and caveats in its README). Resolves the NeMo half of issue #25.
- **`POST /v1/checks`** exists and returns `{status: passed|modified|blocked, content, rail}`; it maps onto the
  webhook's pass / mask / reject. The check API does not run tool rails.
- **Bedrock works as the rails LLM** via `engine: openai` + `parameters.base_url` (same call and bearer token as
  switchyard). The `model` field of each request overrides the config, so the adapter sends the real id.
- **Measured on the 28 cases:** `qwen.qwen3-coder-next` 28/28, `zai.glm-5` 27/28, `openai.gpt-oss-20b-1:0` 16/28
  (reasoning-model output breaks the yes/no parsing, so NeMo blocks harmless text). Through the gateway the
  median check is ~0.7 s (max ~3.2 s) vs 3-4 s median / 8-11 s max for the local Ollama judge, so the
  gateway's fixed 10 s budget is not a problem here.
- **Tradeoffs:** self-check rails only block (no span masking); the text being checked goes to Bedrock rather
  than staying on the machine; the same placeholder trap as the judge (cleaned view fixes it).
- **Not tried:** NeMo's masking rails (GLiNER PII, hosted by NVIDIA), jailbreak/content-safety models, streaming.
