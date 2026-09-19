# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Companion repo to the "Field Notes on the Agentic Stack" LinkedIn series — working notes
and **runnable** code from building an agentic stack in public, one post at a time.
Written posts live in `posts/` (numbered `NN_title.md`); `posts/architecture.md` is a
separate, ongoing versioned log of the system's architecture with diagrams — append new
dated entries there on structural changes, never edit prior ones. `_working/` holds
process notes and post drafts and is gitignored (not for publication).

## Repo structure: one self-contained folder per topic

Each topic in the series gets its **own subfolder**, and each folder is a fully
self-contained snapshot: its own `Dockerfile`, `docker-compose.yml`, `pi-settings.json`,
`.env.example`, etc. — not shared or DRY'd across folders, on purpose (see
`.github/workflows/security-scan.yml`'s comment and `posts/architecture.md`). A folder
generally represents the state of the project *at the time that post was written*; later
folders copy-and-extend from earlier ones rather than the earlier ones being refactored
in place. Current folders, oldest to newest:

- **`pi-multi-provider/`** — Pi in Docker talking to Bedrock, NVIDIA NIM, and local Ollama
  through one `--provider`/`--model` interface.
- **`model-router/`** — adds `switchyard-server` (Rust, built from source in a multi-stage
  Dockerfile) in front of those providers: LLM-classifier-based routing (weak/strong, or
  task-type-aware via `routes.smart-v2`), a `trace-server.mjs` web viewer over the routing
  log, and `failover-proxy.mjs` for availability fallback. Not currently listed in the
  root README's own "Project code" section — treat that as a gap, not as this folder
  being deprecated.
- **`mcp/`** — same switchyard/trace/failover setup as `model-router/` (kept in sync;
  diff the two before assuming a fix only belongs in one), plus direct MCP server wiring
  via `.mcp.json` — the series' **"before"** picture for MCP: one server, one config
  entry, no gateway. Includes two hand-built demo MCP servers (`math-server`,
  `docs-server`) and a containerized MCP Inspector service.
- **`agentgateway/`** — the **"after"** picture: [agentgateway](https://agentgateway.dev/)
  multiplexing multiple MCP servers (the same `math-server`/`docs-server`, plus live
  third-party ones) behind one endpoint, with tool-level policy — e.g. exposing only
  `read` from a backend that also genuinely implements `write`/`delete`. See
  `agentgateway/README.md` for the full walkthrough.
- **`mcp-agentgateway/`** — a copy of `mcp/`'s full stack (kept in sync the same way
  `mcp/`/`model-router/` are; diff before assuming a fix belongs in only one) with an
  `agentgateway` service added on top, fronting the same 3 servers `mcp/` wires
  directly (`math`, `docs`, `github`) with the same read-only-`docs` policy
  `agentgateway/` proves. Exists so the before/after contrast can be shown in one
  folder via MCP Inspector, without touching either `mcp/` or `agentgateway/` in
  place. See `mcp-agentgateway/README.md`.

Each folder's own `README.md` (where present) or the root `README.md`'s per-folder
section is the first place to check for that folder's specifics before reading code.

## Commands

Every folder follows the same basic pattern — `cd` into it, copy `.env.example` to
`.env`, build, run:

```bash
cd <folder>
cp .env.example .env   # fill in provider keys / tokens as needed
docker compose build
docker compose run --rm pi
```

`mcp/` has a `./dev.sh` wrapper that does this (build, then run) in one step — prefer it
over the manual sequence there, since it also fixes a real gotcha (next section).

**Gotcha — `docker compose run` does not publish `ports:` by default.** Unlike
`docker compose up`, `docker compose run` silently skips publishing anything in a
service's `ports:` block unless you pass `--service-ports`. Every folder with a web
viewer (switchyard on :4000/mapped, `trace-server.mjs`, `mcp-trace-server.mjs`,
`failover-proxy.mjs`) is affected — the service runs fine *inside* the container and
looks broken from the host. `mcp/dev.sh` already passes `--service-ports`; do the same
for any other one-off `docker compose run` invocation that needs a published port.

**Runtime log/state files are gitignored, not fixtures** — `.switchyard.log`,
`switchyard-routing.jsonl`, `.trace-server.log`, `.failover-proxy.log`, `failover.jsonl`,
`mcp/logs/` all regenerate on container start and don't exist in a fresh worktree; don't
treat their absence as a bug.

**Tests** are per-folder shell scripts under `tests/` (e.g.
`mcp/tests/test-custom-routing.sh`, `model-router/tests/test-vision-route.sh`) that
exercise a specific routing scenario end-to-end against a running container and assert
on the actual response, not a mocked one:

```bash
docker compose run --rm pi bash tests/test-custom-routing.sh
```

There is no repo-wide build/lint/test command — each folder's `docker compose build` is
its own build step, and there's no linter configured anywhere in the repo.

## Secret scanning

- `gitleaks` runs as a **pre-commit hook**, but it's opt-in per clone:
  `git config core.hooksPath .githooks` (see `.githooks/pre-commit`). It is not active by
  default after a plain clone.
- `.github/workflows/security-scan.yml` runs `gitleaks` on every push/PR to `master`
  regardless, plus a Trivy image-vulnerability scan (report-only, `exit-code: 0`) across
  the `pi-multi-provider`, `model-router`, `mcp` Docker images — `agentgateway/` is not
  currently in that scan matrix.

## MCP-specific architecture (mcp/ and agentgateway/)

- `math-server` and `docs-server` are hand-built MCP servers (Streamable HTTP, stateless),
  each its own tiny Node/Express process in its own container — not spawned as stdio
  subprocesses, because `agentgateway`'s official image is distroless (no node/npm to
  spawn a child process with).
- Both call a small `log-call.mjs` helper (duplicated per-server, not shared — same
  self-contained-folder convention as everything else) that writes structured JSONL to a
  bind-mounted `logs/` directory and also logs to stdout.
- `mcp/mcp-trace-server.mjs` is a small dependency-free `node:http` viewer over that JSONL
  log, styled after `model-router/trace-server.mjs`'s own viewer (same CSS/pattern) but
  kept as a separate file rather than merged into it — the two logs have unrelated shapes
  (LLM routing decisions vs. MCP tool calls).
- `createMcpExpressApp()` defaults to binding `127.0.0.1` with DNS-rebinding protection
  that only trusts `Host: localhost/127.0.0.1/::1` — any server reached via a Docker
  Compose service name (`math-server`, `docs-server`, etc.) needs an explicit
  `allowedHosts` override or it 403s.
- `agentgateway`'s simplified `mcp` mode eagerly reaches *every* configured target during
  a client's `initialize` handshake — one unreachable/misconfigured target fails the
  *entire* gateway's `initialize`, not just that target.

## Switchyard / model routing (model-router/ and mcp/)

- `switchyard-server` is a Rust binary built from source in a multi-stage Dockerfile
  (`FROM rust:latest AS switchyard-builder`, musl-linked for portability) — if a rebuilt
  image reports `switchyard-server: command not found`, check that the final stage still
  has `COPY --from=switchyard-builder /usr/local/cargo/bin/switchyard-server ...`.
- `routes.toml` configures classifier-based routing (`type = "llm_classifier"`,
  `mode = "capability"` for weak/strong, `mode = "custom"` for task-type routing via a
  judge model + JSON-schema-constrained verdict + `target_selector` policy).
- A `reasoning="fall-through selected ..."` line in `.switchyard.log` means the
  classifier's response failed to parse into a usable verdict, not a genuine capability
  judgment — this is independent of which model backs the classifier (confirmed: swapping
  to a larger local model did not fix it, only made it slower).

## Standing conventions (apply beyond just this session)

- **All development work in this repo — file edits, new features, config changes — must
  happen in a dedicated git worktree, not as direct edits against the primary checkout's
  working tree, even for small fixes.** Git administrative operations that inherently
  target `main` itself (merging a finished branch in, `git checkout main`, `git log`,
  `git status`) are fine to run directly. This repo already uses worktrees for
  subagent-driven feature work (`.claude/worktrees/*`) — the rule extends that pattern to
  all new changes.
- **Don't consolidate old topic folders into newer ones.** Each folder is an immutable
  "before" snapshot of the series at that point; a new capability gets a new folder (or a
  clearly-scoped addition to an existing one, like `mcp/`'s MCP servers), not a rewrite of
  an earlier folder into the new shape.
- Pin third-party versions explicitly (Docker image tags, `npx` package versions) rather
  than `@latest`/`latest` — supply-chain-safety convention already established throughout
  (`mcp-proxy-for-aws@1.6.4`, `agentgateway:v1.5.0`, `@modelcontextprotocol/inspector@2.6.0`).
