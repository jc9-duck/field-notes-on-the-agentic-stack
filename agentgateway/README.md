# agentgateway

[agentgateway](https://agentgateway.dev/) (Linux Foundation, Rust, MCP multiplexer)
sitting in front of four MCP servers — two hand-built, two genuinely live/external —
proving it can (1) federate multiple backends behind one endpoint, real third-party
servers included, and (2) restrict which tools a client sees per-backend, independent
of what the backend actually implements.

- `math-server/` — arithmetic tools, no interesting policy. Pure multiplexing proof.
- `docs-server/` — `read`/`write`/`delete` tools over a real bind-mounted folder
  (`docs-server/sample-docs/`). agentgateway restricts the gateway to `read` only;
  `write`/`delete` still work if you call `docs-server` directly, proving the
  restriction is gateway-enforced, not backend-enforced.
- `github` — GitHub's hosted MCP server (`api.githubcopilot.com/mcp/`), live and
  credentialed via `GH_TOKEN`. agentgateway injects the Authorization header itself
  (`policies.backendAuth` on the target, resolved from the gateway container's own env)
  — the client (`pi`, or you via curl) never handles that token at all.
- `aws-knowledge` — AWS's public Knowledge MCP Server
  (`knowledge-mcp.global.api.aws`), live and genuinely credential-free — no token, no
  signup, matching this series' zero-cost bar. (Distinct from the SigV4-signed, managed
  `aws-mcp.us-east-1.api.aws` server `mcp/` used to wire directly — that one needs its
  own signing proxy as a sidecar to become an agentgateway target, since agentgateway's
  distroless image can't spawn `uvx mcp-proxy-for-aws` as a subprocess. Not pursued here
  since a public, zero-credential server is a strictly simpler second live target.)
- `config.yaml` — agentgateway's config (plain static file, no identity/JWT
  requirement right now — see "Identity" below).

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
docker compose build
docker compose up -d math-server docs-server agentgateway
```

Runs on either Docker Desktop or [Colima](https://github.com/abiosoft/colima). If you're
on Colima and your project lives outside `$HOME` (e.g. an external drive), make sure
that path is mounted: `colima start --mount /path/to/drive:w`.

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

Same session as above (`tools/list` now returns 54 tools total: 4 math + 1 docs +
~45 github + 5 aws-knowledge — GitHub's own tool count varies with the token's scopes).

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

## Identity (coming back later, as its own step)

The original design (already spec'd, not re-derived from scratch when picked back up):
JWT auth via `mcpAuthentication`, provider-agnostic through three env vars
(`OIDC_ISSUER`/`OIDC_AUDIENCE`/`OIDC_JWKS_URI`) rendered into `config.yaml` by a small
`config-init` sidecar (agentgateway's official image is distroless, no `envsubst`
available inside it), with a normalized `role` JWT claim so the CEL policy never
references a specific identity provider by name. AWS Cognito first (a `setup-cognito.sh`
script provisions a real User Pool + role-claim Lambda trigger), Okta/Entra ID as
later, separate steps. See the follow-up GitHub issue for the full spec.
