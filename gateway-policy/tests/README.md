# gateway-policy tests

End-to-end, like the rest of the repo: real agentgateway container, assertions on real
responses -- but with a tiny mock OpenAI upstream (`lib/mock-upstream.mjs`) so no
provider keys or cost are involved, and the test can see exactly what the gateway
*forwarded*.

```bash
bash gateway-policy/tests/test-regex-guardrails.sh   # needs docker, curl, jq; ~1 min
```

- `lib/harness.sh` -- starts the mock + gateway on a private docker network from a policy
  fragment; `chat`, `upstream_saw`, `assistant_said` helpers. The config is passed as
  bytes (`-c`), so there is no bind-mount or file-sharing setup. Containers are
  `gp-mock` / `gp-gw` on host port `14100` (override with `HARNESS_PORT`).
- `test-judge-guardrails.sh` -- the LLM judge, through a real gateway, driven by
  `../fixtures/judge-cases.json` (28 labeled cases, request and response). Phase A runs the
  built-in regex only (`../llm-guardrails-builtin.yaml`) and pins what it misses; phase B adds the
  judge (`../llm-judge.yaml`) and shows the same cases caught; phase C stops the judge and checks
  failClosed vs failOpen. Needs Ollama on the host with `llama3.1:8b` pulled, and **skips cleanly**
  without it. Slow cases (judge over the gateway's fixed 10 s budget) are reported as `SLOW`,
  never as a pass. See `../judge-webhook/README.md` for the design and the latency limit.
  `lib/harness.sh` gains `harness_start_judge`, `harness_stop_judge`, `harness_ollama_ready` and
  `mock_next_reply` (the mock's next completion replies with given text, so response-side cases
  need no trigger string in the prompt).
- `test-nemo-guardrails.sh` -- NVIDIA NeMo Guardrails as the LLM guardrail (`../llm-nemo.yaml`),
  same 28 cases, rails running on a Bedrock model. NeMo can only block, so judge-"mask" cases are
  expected to be rejected whole (451). Also checks failClosed vs failOpen with NeMo down. Needs
  `AWS_BEARER_TOKEN_BEDROCK` exported and **skips cleanly** without it; the first run builds the
  pinned NeMo image. Harness additions: `harness_start_nemo`, `harness_stop_nemo`,
  `harness_bedrock_ready`. See `../nemo/README.md` for the design and the model comparison.
- `clean.sh` -- housekeeping: removes leftover `gp-*` containers/network and saved logs
  older than 14 days; `clean.sh --all` deletes every saved log.
- `test-regex-guardrails.sh` -- replays `../fixtures/` against `../llm-guardrails.yaml`:
  SSN/card -> 403, email/phone/address/account/IBAN -> masked, clean control untouched,
  response masking, and the pinned tool-result gap.

## Saved logs

After each run the harness appends the gateway's per-request log lines to
`gateway-policy/tests/out/gateway-guardrails.log` (the container, and its own logs, are
removed right after). Only request lines are kept: status, which guard fired, the action,
duration. There are no request bodies, so no PII, and the startup config dump (which can
echo keys) is dropped.

- **Size-capped.** At 5 MB (`HARNESS_LOG_MAX_KB`) the file rotates to `.1`, `.2`, `.3`
  (`HARNESS_LOG_KEEP`) and the oldest is deleted, so the total stays around 20 MB at most.
  One run is ~50 KB, so that is roughly 100 runs per file.
- **Never committed.** `gateway-policy/tests/out/` is gitignored. Logs are runtime output,
  not source; when a log is worth showing, paste a short sample here (below) instead.
- **Cleanup:** `bash gateway-policy/tests/clean.sh` (or `--all`).

Sample, from a real run (trimmed: timestamp and source address removed). The
`agw.ai.guardrails` field is what to assert on or screenshot:

```
http.status=403 protocol=llm agw.ai.guardrails=[{"phase": "request", "guard": "regex", "action": "reject"}] error="request rejected by regex guardrail" reason=Guardrail duration=3ms
http.status=200 protocol=llm gen_ai.request.model=gpt-test agw.ai.guardrails=[{"phase": "request", "guard": "regex", "action": "mask"}] duration=12ms
http.status=200 protocol=llm gen_ai.request.model=gpt-test duration=1ms
```

Reject (SSN in the prompt), mask (email redacted, request still sent), and a clean
request with no guardrail field at all.
