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
- `test-regex-guardrails.sh` -- replays `../fixtures/` against `../llm-guardrails.yaml`:
  SSN/card -> 403, email/phone/address/account/IBAN -> masked, clean control untouched,
  response masking, and the pinned tool-result gap.
