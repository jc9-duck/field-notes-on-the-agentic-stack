# agentgateway

[agentgateway](https://agentgateway.dev/) (Linux Foundation, Rust, MCP multiplexer)
sitting in front of two example MCP servers — proving it can (1) federate multiple
backends behind one endpoint, and (2) restrict which tools a client sees per-backend,
independent of what the backend actually implements.

- `math-server/` — arithmetic tools, no interesting policy. Pure multiplexing proof.
- `docs-server/` — `read`/`write`/`delete` tools over a real bind-mounted folder
  (`docs-server/sample-docs/`). agentgateway restricts the gateway to `read` only;
  `write`/`delete` still work if you call `docs-server` directly, proving the
  restriction is gateway-enforced, not backend-enforced.
- `config.yaml.template` — agentgateway's config, rendered by `config-init/` via
  `envsubst` at container start. The only provider-specific values anywhere in it are
  `${OIDC_ISSUER}`/`${OIDC_AUDIENCE}`/`${OIDC_JWKS_URI}` — everything else, including the
  CEL tool-authorization policy, is identity-provider-agnostic.
- `identity-providers/` — one file per IdP. `cognito.env.example` (+ `setup-cognito.sh`)
  is filled in; `okta.env.example`/`entra.env.example` are stubs for later.

## Quickstart

```bash
cd agentgateway
cp .env.example .env   # fill in pi's provider keys

# Provision the identity provider (creates real, persistent AWS resources —
# read the script before running it):
export COGNITO_TEST_PASSWORD='<a password meeting Cognito's default policy>'
./identity-providers/setup-cognito.sh
# copy the printed OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URI into .env

docker compose build
docker compose up -d math-server docs-server config-init agentgateway
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
# No Authorization header at all -> rejected outright, no session even attempted
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4000/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":0,"method":"tools/list"}'
# -> 401

# Mint a bearer token (see setup-cognito.sh's own printed output for the
# exact command using your test user; a "viewer" role account has no
# custom:role=editor attribute)
export TOKEN='<ID token from admin-initiate-auth>'

# initialize establishes the gateway's own session (separate from anything
# docs-server/math-server track themselves)
SESSION=$(curl -sD - -o /dev/null http://localhost:4000/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}' \
  | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r')

# tools/list through the gateway shows both backends' tools in one response —
# for a non-editor token, docs_write/docs_delete are absent entirely (not
# just denied), since the CEL policy filters tools/list too:
curl -s http://localhost:4000/mcp -H "Authorization: Bearer $TOKEN" -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# read on docs succeeds through the gateway
curl -s http://localhost:4000/mcp -H "Authorization: Bearer $TOKEN" -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"docs_read","arguments":{}}}'

# delete on docs, through the gateway, as a non-editor -> "Unknown tool: docs_delete"
# (the policy hides it, rather than a generic permission-denied)
curl -s http://localhost:4000/mcp -H "Authorization: Bearer $TOKEN" -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"docs_delete","arguments":{"filename":"changelog.md"}}}'

# ...but delete genuinely works when called directly against docs-server,
# bypassing the gateway entirely (no auth needed — docs-server has none of
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

An "editor" token (from a test user with `custom:role=editor`) gets `docs_write` and
`docs_delete` in its own `tools/list` and can actually call them through the gateway —
same requests, different token, different tool visibility.

Then run pi against the same gateway:

```bash
export AGENTGATEWAY_TOKEN="$TOKEN"
docker compose run --rm pi
```

## Swapping identity providers later

Only `identity-providers/<provider>.env.example`'s values change. `config.yaml.template`
and the CEL policy in `docker-compose.yml`'s `config-init` service never reference
Cognito by name — see that file's own comments.
