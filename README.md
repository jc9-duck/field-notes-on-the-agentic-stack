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

### [`agentgateway/`](agentgateway/)

[agentgateway](https://agentgateway.dev/) multiplexing two example MCP servers behind
one endpoint, with tool-level access control (the gateway exposes only `read` from a
server that genuinely also implements `write`/`delete`) and JWT identity via AWS
Cognito — built so other identity providers can be swapped in later via
`identity-providers/` without touching the gateway config itself.

Quickstart:
```bash
cd agentgateway
cp .env.example .env   # fill in pi's provider keys
./identity-providers/setup-cognito.sh   # provisions a Cognito User Pool, prints .env values
docker compose build
docker compose up -d math-server docs-server config-init agentgateway
```

See [`agentgateway/README.md`](agentgateway/README.md) for the full walkthrough
(minting a test token, proving the gateway-vs-backend restriction, running pi against
the gateway).

## What's coming

MCP, observability, and more — each as its own subfolder here as the corresponding
post gets written.
