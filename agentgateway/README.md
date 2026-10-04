# agentgateway

**Iteration 1 of a staged build.** This folder is built up step by step, each step its
own commit and its own documented/demoed piece, rather than shipped fully-wired upfront
— see "What's still coming" at the bottom. Right now: [agentgateway](https://agentgateway.dev/)
(Linux Foundation, Rust, MCP multiplexer) sitting in front of four MCP servers — two
hand-built, two genuinely live/external — proving it can (1) federate multiple
backends behind one endpoint, real third-party servers included, and (2) restrict which
tools a client sees per-backend, independent of what the backend actually implements.
No identity, no guardrails, no request tracing, and no credentialed backends yet — this
iteration is deliberately all no-auth-required targets; those are later steps.

**Also carries `mcp/`'s full switchyard stack** — dynamic LLM routing
(`switchyard-server`), a failover chain across providers, request tracing, and
Prometheus/Grafana — so this folder now does both things at once: an MCP tool
gateway *and* an LLM routing gateway, coexisting rather than living in separate
folders. Ports are shifted from `mcp/`'s own (6xxx instead of 5xxx, 3102/3100/9190
instead of 3002/3000/9090) specifically so both folders can run at the same time
without colliding — see "Dynamic model routing" below.

- `math-server/` — arithmetic tools, no interesting policy. Pure multiplexing proof.
- `docs-server/` — `read`/`write`/`delete` tools over a real bind-mounted folder
  (`docs-server/sample-docs/`), published directly on `localhost:3102` (unlike
  `math-server`, which is compose-internal only — moved from `3002` to avoid
  colliding with `mcp/`'s own docs-server, which already uses that port).
  agentgateway restricts the gateway to `read` only; `write`/`delete` still work
  if you call `docs-server` directly on its own port, proving the restriction is
  gateway-enforced, not backend-enforced.
- `mcp-inspector` — MCP's own dev tool, containerized (pinned
  `@modelcontextprotocol/inspector@2.6.0`), for browsing the before/after
  contrast above visually rather than via curl — see "Proving the restriction
  visually" below.
- `github` — GitHub's hosted MCP server (`api.githubcopilot.com/mcp/`), live and
  credentialed via `GH_TOKEN`. agentgateway injects the Authorization header itself
  (`policies.backendAuth` on the target, resolved from the gateway container's own env)
  — the client (`pi`, or you via curl) never handles that token at all.
- `aws-knowledge` — AWS's public Knowledge MCP Server
  (`knowledge-mcp.global.api.aws`), live and genuinely credential-free — no token, no
  signup, matching this series' zero-cost bar. (A credentialed counterpart exists too —
  the same managed, SigV4-signed `aws-mcp.us-east-1.api.aws` server `mcp/` wires
  directly as a stdio subprocess, real AWS account access, 15,000+ APIs — but it's
  deliberately not part of this iteration: nothing here should require any auth at all,
  AWS included. A working stdio→HTTP bridge for it was built and evaluated, and is
  recoverable from git history whenever a credentialed-backend step becomes its own
  documented iteration, same treatment as identity below.)
- `config.yaml` — agentgateway's config (plain static file, no identity/JWT
  requirement right now — see "Identity" below). Two more genuinely free,
  no-signup public servers — `deepwiki` (`mcp.deepwiki.com`) and `context7`
  (`mcp.context7.com`) — were multiplexed here too, but pulled back out to
  keep this iteration's active target list consistent with the
  `.mcp.json`/`AGENTS.md` tool-routing work landing alongside this change
  (which currently only curates math/docs/github tools). Not lost — both
  are intact in git history, ready to come back as their own documented
  step once tool-routing coverage catches up to them.

**Identity/JWT auth is deliberately not wired in yet.** An earlier pass built full
AWS Cognito-backed JWT auth (provider-agnostic, swappable identity providers) for this
folder; it's being reintroduced deliberately, step by step, with its own documentation
and demo, rather than baked in upfront. The original implementation is intact in git
history (commit `aef38b5`) and re-specified in its own follow-up issue — nothing was
lost, just deferred. Right now, `mcpAuthorization`'s tool-restriction policy applies to
every caller unconditionally (no "editor" escape hatch), so the gateway-vs-backend demo
below still holds without any token.

## Quickstart

```bash
cd agentgateway
cp .env.example .env   # fill in pi's provider keys, plus GH_TOKEN for the live github target
export GH_TOKEN=$(gh auth token)   # or set it in .env directly
./dev.sh                # always rebuilds, brings up math/docs/gateway, then runs pi
```

`./dev.sh` is the one-step version of: `docker compose build`, then
`docker compose up -d math-server docs-server agentgateway`, then
`docker compose run --rm pi` — same pattern as `mcp/dev.sh`.

Runs on either Docker Desktop or [Colima](https://github.com/abiosoft/colima). If you're
on Colima and your project lives outside `$HOME` (e.g. an external drive), make sure
that path is mounted: `colima start --mount /path/to/drive:w`.

### Dynamic model routing (switchyard), alongside the MCP gateway

`switchyard-server`, `trace-server.mjs`, `mcp-trace-server.mjs`, and
`failover-proxy.mjs` all run inside the `pi` container (started by
`entrypoint.sh`, same as `mcp/`), and Prometheus/Grafana scrape/visualize
switchyard's routing decisions. `./dev.sh` starts all of it automatically —
nothing extra to run beyond bringing up `prometheus`/`grafana` if you want the
dashboard:

```bash
docker compose up -d prometheus grafana   # optional -- dashboards at :3100
```

| What | Port | Check |
|---|---|---|
| switchyard-server | `6000` | `curl localhost:6000/health` |
| trace-server.mjs (routing-decision viewer) | `6321` | open `http://localhost:6321` |
| mcp-trace-server.mjs (math/docs call viewer) | `6322` | open `http://localhost:6322` |
| failover-proxy.mjs (default entrypoint, `model: "auto"`) | `6100` | `curl localhost:6100/v1/models` |
| Grafana (routing dashboard) | `3100` | open `http://localhost:3100` |
| Prometheus | `9190` | open `http://localhost:9190` |

Inside a `pi` session, `/model` now shows `switchyard` (direct classifier
routes), `auto` (the failover chain — the default), and `ollama` (bypasses
routing entirely), alongside `pi`'s own built-in providers. `routes.toml` and
all four `pi-extensions/*.mjs` are carried over unchanged from `mcp/` — see
that folder's own docs for how the weak/strong and task-type classifiers work.

These ports are deliberately different from `mcp/`'s own (`5000`/`5321`/`5322`/
`5100`/`3000`/`9090`) so both folders' stacks can run at the same time without
a port collision — same reasoning `mcp/` already used when it shifted its own
ports away from `model-router/`'s.

### Host gotcha: Ollama silently truncates to 2048 tokens

Local Ollama (`llm_clients.ollama` in `routes.toml`) truncates every request
to its default 2048-token context window regardless of the loaded model's
real context size — confirmed with an ~8k-token request that came back
`prompt_tokens: 2050`, dropping the *head* of the prompt (pi's system prompt
+ tool schemas) rather than erroring. This looks like "the model can't
handle this many tools," but it's a host Ollama config gap, not a model or
gateway problem — it affects every folder in this repo that talks to local
Ollama (`model-router/`, `mcp/`, `agentgateway/`), not just this one. Fix:
set `OLLAMA_CONTEXT_LENGTH=16384` (raises the KV cache's RAM footprint —
`OLLAMA_KV_CACHE_TYPE=q8_0` and flash attention are already set to offset
that). This is a one-time host change, not something `docker compose up`
can do for you — **and don't hand-edit the ollama LaunchAgent plist
directly**: on Homebrew 7.0.6+, `brew services restart` regenerates that
plist from the formula's template on every run (it even renamed the
service from `homebrew.mxcl.ollama` to `sh.brew.ollama` along the way),
silently discarding manual edits. Use Homebrew's actual persistence
mechanism instead — `~/.homebrew/services/ollama.env`
(`$HOMEBREW_USER_CONFIG_HOME/services/<formula>.env`; see `brew services
--help`), one `KEY=value` per line:

```
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
OLLAMA_MAX_LOADED_MODELS=2
OLLAMA_CONTEXT_LENGTH=16384
```

then `brew services restart ollama`. Verified on this host: `ollama ps`'s
`CONTEXT` column went from `2048`/`4096` to `16384`, and the diagnostic
8k-token request's `prompt_tokens` went from the truncated `2050` to the
full `8194`.

### Exposing curated tools to pi (`.mcp.json` `directTools`)

`pi-mcp-adapter` defaults to **proxy mode**: pi's model sees one generic
`mcp`/`mcp__gateway` tool ("MCP namespace proxy for gateway") instead of the
gateway's actual tools. Next to a well-described built-in like `web_search`,
a small model reliably picks `web_search` over the opaque proxy tool even for
requests the gateway can answer directly (confirmed: GitHub-profile questions
routed to `web_search` in 2/2 baseline runs). `.mcp.json`'s `directTools` list
opts specific tools out of proxy mode so they appear to the model as their own
named tools (`gateway_math_add`, `gateway_docs_read`, `gateway_github_get_me`,
etc.) — this repo curates that list to 12 tools (math ×4, `docs_read`, 7
GitHub read tools) rather than all 36 the gateway multiplexes, since the full
set is ~143 KB of tool-schema JSON, too large to reliably fit a small local
model's context alongside pi's own system prompt and tools.

`AGENTS.md` in this folder is pi's [context-file](
https://github.com/earendil-works/pi/blob/main/docs/configuration.md#context-files)
mechanism (loaded automatically from the working directory, no project trust
required) telling the model which of those curated tools to prefer over
`web_search` for GitHub/docs/math questions.

### Proving the restriction visually, via MCP Inspector

Two separate Inspector instances, each already connected to one side of the
comparison — open both tabs side by side rather than re-pointing one Inspector
back and forth:

```bash
docker compose up -d mcp-inspector-docs-server mcp-inspector-gateway
```

- **Raw `docs-server`:** <http://localhost:7274/?serverUrl=http%3A%2F%2Fdocs-server%3A3002%2Fmcp&transport=http&autoConnect=agentgateway-demo>
  `tools/list` shows `read`, `write`, `delete`. Call `write` or `delete` — both
  succeed, mutating real files under `docs-server/sample-docs/`.
- **Via `agentgateway`:** <http://localhost:7284/?serverUrl=http%3A%2F%2Fagentgateway%3A4000%2Fmcp&transport=http&autoConnect=agentgateway-demo>
  `tools/list` shows `docs_read` but **not** `docs_write`/`docs_delete` (plus the
  math/github/aws-knowledge tools, since this endpoint multiplexes every
  backend) — the CEL policy filters `tools/list` itself, not just enforcement.
  Calling `docs_read` succeeds; calling `docs_delete` by name returns
  `Unknown tool: docs_delete`.

Both links auto-connect on load (Inspector's deep-link query params — `serverUrl`
+ `transport` + `autoConnect` matching `MCP_INSPECTOR_API_TOKEN` in
docker-compose.yml) instead of needing the connect form filled in by hand. The
`serverUrl` host (`docs-server`/`agentgateway`, not `localhost`) is deliberate:
Inspector's backend — not your browser — makes that connection, from inside the
compose network, so it uses the internal service name and port, not the
host-published one.

That's the whole before/after: same backend, same files, two different ports —
one genuinely restricted, one not.

### Proving the multiplexing + tool-restriction demo

Tool names are prefixed by target when multiplexing (`math_add`, `docs_read`, ...) —
confirmed empirically, not documented anywhere at time of writing. agentgateway also
keeps its own session on top of this (independent of docs-server/math-server's own
stateless HTTP servers): every call after `initialize` needs the `mcp-session-id`
header it returns.

```bash
# initialize establishes the gateway's own session (separate from anything
# docs-server/math-server track themselves) -- no auth needed right now.
SESSION=$(curl -sD - -o /dev/null http://localhost:4000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}' \
  | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r')

# tools/list through the gateway shows both backends' tools in one response --
# docs_write/docs_delete are absent entirely (not just denied), since the
# CEL policy filters tools/list too:
curl -s http://localhost:4000/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# read on docs succeeds through the gateway
curl -s http://localhost:4000/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"docs_read","arguments":{}}}'

# delete on docs, through the gateway -> "Unknown tool: docs_delete"
# (the policy hides it, rather than a generic permission-denied)
curl -s http://localhost:4000/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"docs_delete","arguments":{"filename":"changelog.md"}}}'

# ...but delete genuinely works when called directly against docs-server,
# bypassing the gateway entirely (no auth needed -- docs-server has none of
# its own; the gateway is the only thing gating access here):
docker compose exec -T docs-server node -e "
  const http = require('node:http');
  const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'delete',arguments:{filename:'changelog.md'}}});
  const req = http.request({host:'localhost',port:3002,path:'/mcp',method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','Content-Length':Buffer.byteLength(body)}},
    res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>console.log(d)); });
  req.write(body); req.end();
"
```

Then run pi against the same gateway:

```bash
docker compose run --rm pi
```

### Proving the live external servers

Same session as above. `tools/list` returns ~55 tools: 4 math + 1 docs + ~45 github +
5 aws-knowledge (GitHub's own count varies with the token's scopes) — no auth required
for any of it beyond GitHub's own `GH_TOKEN`.

```bash
# Real GitHub profile data, via agentgateway's injected token -- pi never sees GH_TOKEN
curl -s http://localhost:4000/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"github_get_me","arguments":{}}}'

# Real AWS documentation search, no credentials anywhere in the request
curl -s http://localhost:4000/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"aws-knowledge_aws___search_documentation","arguments":{"search_phrase":"S3 bucket versioning"}}}'
```

## What's still coming

Each of these lands as its own step — its own commit, its own README update, its own
verified demo — not bundled into one pass:

- **Identity.** The original design (already spec'd, not re-derived from scratch when
  picked back up): JWT auth via `mcpAuthentication`, provider-agnostic through three
  env vars (`OIDC_ISSUER`/`OIDC_AUDIENCE`/`OIDC_JWKS_URI`) rendered into `config.yaml`
  by a small `config-init` sidecar (agentgateway's official image is distroless, no
  `envsubst` available inside it), with a normalized `role` JWT claim so the CEL policy
  never references a specific identity provider by name. AWS Cognito first (a
  `setup-cognito.sh` script provisions a real User Pool + role-claim Lambda trigger),
  Okta/Entra ID as later, separate steps. See the follow-up GitHub issue for the full
  spec.
- **Guardrails** — regex-based `promptGuard` first, then an LLM-based guardrail via
  NVIDIA NeMo Guardrails as a custom webhook.
- **Sequence-diagram request tracing**, the same `trace-server.mjs`-style viewer
  `model-router/` already has, adapted to agentgateway's own request/policy logging.
