# mcp-agentgateway

Side-by-side comparison of this series' "before" and "after" MCP pictures, in one
folder: `mcp/`'s full direct-wiring stack (switchyard, failover-proxy, trace viewers,
MCP Inspector, tests — copied over unchanged) plus an `agentgateway` service fronting
the same 3 servers `mcp/` already wires directly (`math`, `docs`, `github`), with the
same read-only-`docs` tool policy [`agentgateway/`](../agentgateway/README.md) already
proved. Point the same MCP Inspector at the raw backend, then at the gateway, and
compare.

- `docs-server` genuinely implements `read`, `write`, and `delete` over a real
  bind-mounted folder (`docs-server/sample-docs/`) — reachable directly on
  `localhost:3002` exactly as in `mcp/`.
- `config.yaml`'s `mcpAuthorization` policy restricts the gateway (`localhost:4001`) to
  `docs`'s `read` tool only — `write`/`delete` are hidden from `tools/list` entirely,
  not just denied, and still work when called directly against `docs-server`, proving
  the restriction is gateway-enforced, not backend-enforced.
- `pi`'s own `.mcp.json` is untouched — it keeps `mcp/`'s original 3 flat entries
  (`math`, `docs`, `github`), same as that folder. Only MCP Inspector talks to the
  gateway in this folder; `pi` itself isn't wired through it here.

## Quickstart

```bash
cd mcp-agentgateway
cp .env.example .env   # fill in provider keys, plus GH_TOKEN for git push + github MCP
./dev.sh                # builds + runs pi with ports published, same as mcp/

# Bring up the gateway too (not started by dev.sh/pi's own compose run):
export GH_TOKEN=$(gh auth token)   # or set it in .env
docker compose up -d agentgateway

# MCP Inspector -- open http://localhost:6274 (URL w/ token printed in logs)
docker compose up -d mcp-inspector
```

Same Docker Desktop/Colima notes as every other folder in this repo.

## Proving the raw-vs-gated restriction, via Inspector

1. Open `http://localhost:6274`, connect to `http://localhost:3002/mcp` (raw
   `docs-server`, published the same way `mcp/` publishes it). `tools/list` shows
   `read`, `write`, `delete`. Call `write` or `delete` — both succeed, mutating real
   files under `docs-server/sample-docs/`.
2. Point the same Inspector at `http://localhost:4001/mcp` (the `agentgateway`
   service). `tools/list` shows `docs_read` but **not** `docs_write`/`docs_delete` —
   the policy filters `tools/list` itself, not just enforcement. Calling `docs_read`
   succeeds; calling `docs_delete` by name returns `Unknown tool: docs_delete`.
3. `math_*` and `github_*` tools are reachable and functional through the gateway too
   — only `docs` carries a restrictive policy.

## Proving it via curl (scriptable, no browser)

Mirrors [`agentgateway/README.md`](../agentgateway/README.md)'s own demo, pointed at
this folder's port (`4001`, not `4000`, to avoid colliding with `agentgateway/` if
both are running at once).

```bash
# initialize establishes the gateway's own session -- no auth needed right now.
SESSION=$(curl -sD - -o /dev/null http://localhost:4001/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}' \
  | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r')

# tools/list through the gateway -- docs_write/docs_delete are absent entirely:
curl -s http://localhost:4001/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# read on docs succeeds through the gateway
curl -s http://localhost:4001/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"docs_read","arguments":{}}}'

# delete on docs, through the gateway -> "Unknown tool: docs_delete"
curl -s http://localhost:4001/mcp -H "mcp-session-id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"docs_delete","arguments":{"filename":"changelog.md"}}}'

# ...but delete genuinely works called directly against docs-server on its own
# published port, bypassing the gateway entirely:
curl -s http://localhost:3002/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete","arguments":{"filename":"changelog.md"}}}'
```

## What this folder is not

Not a replacement for either `mcp/` or `agentgateway/` — both stay as they are, per
this repo's immutable-snapshot convention. This folder exists solely to show both
pictures at once without switching directories. It doesn't front the extra live
servers `agentgateway/` also multiplexes (`aws-knowledge`, `deepwiki`, `context7`), and
it doesn't add identity/JWT — same deferral as `agentgateway/`.
