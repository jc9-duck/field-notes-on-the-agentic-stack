# Field Notes on the Agentic Stack

Companion repo to my LinkedIn series of the same name — working notes and runnable code
from building out an agentic stack in public, one post at a time.

## Series so far

Written posts live in [`posts/`](posts/):

- [01 — Intro](posts/01_intro_field_notes_on_the_agentic_stack.md)
- [02 — A history of coding agents](posts/02_history_of_coding_agents.md)
- [03 — Setting up Pi](posts/03_setting_up_pi.md)
- [04 — Bring your own model](posts/04_bring_your_own_model.md)
- [Architecture log](posts/architecture.md) — versioned snapshots of the system as it
  evolves, with diagrams

## Project code

Each topic in the series gets its own subfolder alongside this one as the series grows.

### [`pi-multi-provider/`](pi-multi-provider/)

The Pi setup from posts 03-04: Pi running in Docker, configured to talk to Amazon Bedrock,
NVIDIA NIM, and a locally-hosted Ollama model — all through the same `--provider`/`--model`
interface.

Quickstart:
```bash
cd pi-multi-provider
cp .env.example .env   # fill in whichever provider keys you're using
docker compose build
docker compose run --rm pi
```

Runs on either Docker Desktop or [Colima](https://github.com/abiosoft/colima). If you're on
Colima and your project lives outside `$HOME` (e.g. an external drive), make sure that path
is mounted: `colima start --mount /path/to/drive:w`.

### [`mcp/`](mcp/)

Wiring MCP (Model Context Protocol) servers directly into the same Pi setup, one
`.mcp.json` entry per server — no gateway in front of them. This is the series' "before"
picture: `agentgateway/` (below) is the "after," multiplexing the same kind of servers
behind one endpoint. Four servers, each its own `.mcp.json` entry: GitHub's hosted MCP
server (credentialed via `GH_TOKEN`); `math-server` and `docs-server`, the same
hand-built servers `agentgateway/` fronts, copied in here per this repo's
self-contained-snapshot convention — `docs-server`'s `write`/`delete` tools are fully
reachable here, with no policy layer to restrict them, unlike the gateway version. (A
fourth entry, AWS's managed MCP server via `mcp-proxy-for-aws`, was removed — it needs a
live AWS SSO session that had expired; see `mcp/.mcp.json`'s git history.) Also bakes in
the GitHub CLI so `git push`/`gh` work from inside the container over HTTPS via a
`GH_TOKEN`, rather than fighting the host's global SSH config or the macOS Keychain.

Quickstart:
```bash
cd mcp
cp .env.example .env   # fill in provider keys, plus GH_TOKEN for git push + the github MCP server
docker compose build
docker compose run --rm pi
```

Same Docker Desktop/Colima notes as `pi-multi-provider/` above.

### [`agentgateway/`](agentgateway/)

[agentgateway](https://agentgateway.dev/) multiplexing two example MCP servers behind
one endpoint, with tool-level access control (the gateway exposes only `read` from a
server that genuinely also implements `write`/`delete`). Identity (JWT via AWS Cognito,
built to be provider-swappable) is designed but deliberately deferred to its own
follow-up step rather than baked in upfront — see `agentgateway/README.md`.

Quickstart:
```bash
cd agentgateway
cp .env.example .env   # fill in pi's provider keys
docker compose build
docker compose up -d math-server docs-server agentgateway
```

See [`agentgateway/README.md`](agentgateway/README.md) for the full walkthrough
(proving the gateway-vs-backend restriction, running pi against the gateway).

## What's coming

Additional agentgateway identity providers, sequence-diagram request tracing,
guardrails, and more — each tracked as its own issue as the series continues.
