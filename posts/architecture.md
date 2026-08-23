# pi Sandbox — Architecture Log

Versioned snapshots of this project's architecture. Each entry below is a checkpoint in
time: a brief description of the system state plus the diagram(s) that represent it.

**Maintainer note (to self, ongoing):** whenever a structural change lands (new provider,
new persistence mechanism, new integration like SwitchYard), append a new version below
rather than editing prior ones. Each entry gets: a version number, a date, a short
paragraph on what changed and why, and updated diagram(s). Keep prior versions intact —
this is a log, not a living single diagram — so the project's evolution stays legible.

---

## v1 — 2026-08-22 — Multi-provider pi (Bedrock + NVIDIA + local Ollama)

### Description
`pi` runs in a Docker container (`docker-compose.yml` + `Dockerfile`) with credentials for
Amazon Bedrock and NVIDIA NIM passed through as environment variables (backed by a
gitignored `.env`). Config (`pi-settings.json`) and installed packages are baked into the
image via `COPY`/`RUN pi install` for reproducibility, rather than relying on the
container's ephemeral runtime state. Session history is redirected out of the ephemeral
container filesystem into the bind-mounted project directory via `sessionDir`.

The newest piece: a locally-hosted model (Ollama, running natively on macOS to get Metal
GPU acceleration — Docker Desktop on Apple Silicon can't pass Metal through to a
containerized process) is wired in as a fully custom `pi` provider via the
`pi.registerProvider()` extension API. The extension (`pi-extensions/ollama-provider.mjs`)
does live model discovery against Ollama's OpenAI-compatible endpoint at container
startup, and is loaded automatically via `pi-settings.json`'s `extensions` array. From
`pi`'s perspective, Bedrock, NVIDIA, and Ollama are indistinguishable — each is just a
`baseUrl` + API shape + model list; `--provider X --model Y` is the only thing that
changes across all three.

### Diagram — request flow across providers

```mermaid
flowchart TB
    subgraph container["pi container (Docker)"]
        settings["pi-settings.json<br/>extensions: [ollama-provider.mjs]"]
        ext["ollama-provider.mjs<br/>fetch(baseUrl + /models)<br/>pi.registerProvider('ollama', ...)"]
        table["pi's provider table<br/>amazon-bedrock → AWS endpoint<br/>nvidia → integrate.api.nvidia.com<br/>ollama → host.docker.internal:11434/v1"]
        settings -->|"load at startup"| ext
        ext -->|"registers"| table
    end

    table -->|"--provider amazon-bedrock"| bedrock["AWS Bedrock (cloud)"]
    table -->|"--provider nvidia"| nim["NVIDIA NIM (cloud)"]
    table -->|"--provider ollama"| dns["host.docker.internal"]

    dns -->|"Docker Desktop host bridge"| mac["Your Mac (host)<br/>ollama serve :11434<br/>Metal-accelerated llama3.2:1b"]
```

### Diagram — ASCII equivalent
```
┌─────────────────────── pi (inside Docker container) ────────────────────────┐
│                                                                              │
│  pi-settings.json                                                           │
│  { "extensions": ["/work/pi-extensions/ollama-provider.mjs"] }              │
│         │                                                                   │
│         │  "load and run this file at startup"                             │
│         ▼                                                                   │
│  ollama-provider.mjs                                                        │
│  ┌────────────────────────────────────────────┐                            │
│  │ fetch(baseUrl + "/models")   ← discovery    │                            │
│  │ pi.registerProvider("ollama", {             │                            │
│  │   baseUrl: "http://host.docker.internal     │                            │
│  │             :11434/v1",                     │                            │
│  │   api: "openai-completions",                │                            │
│  │   models: [ ...whatever Ollama reports ]    │                            │
│  │ })                                          │                            │
│  └────────────────────────────────────────────┘                            │
│         │  registers into ...                                              │
│         ▼                                                                   │
│  pi's internal provider table (all look identical to pi):                  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ amazon-bedrock → baseUrl: AWS Bedrock endpoint     (bearer token)    │  │
│  │ nvidia         → baseUrl: integrate.api.nvidia.com (API key)        │  │
│  │ ollama         → baseUrl: host.docker.internal:11434/v1 (no key)    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│         │  --provider X --model Y  →  POST {baseUrl}/chat/completions      │
└─────────┼────────────────────────────────────────────────────────────────┘
          │
   ┌──────┼──────────────┬────────────────────────┐
   ▼                     ▼                        ▼
AWS Bedrock         NVIDIA NIM           host.docker.internal
 (cloud)              (cloud)                     │
                                                    │ Docker Desktop's
                                                    │ host network bridge
                                                    ▼
                                        ┌─────────────────────────┐
                                        │      Your Mac (host)     │
                                        │  ollama serve  :11434    │
                                        │  Metal-accelerated       │
                                        │  llama3.2:1b             │
                                        └─────────────────────────┘
```

### Known-good state at this version
- Bedrock + NVIDIA: authenticated, confirmed working.
- Ollama: `llama3.2:1b`, confirmed working end-to-end (`pi` → extension → Ollama → Metal).
- Session persistence: confirmed working via `pi --resume` (Current Folder scope shows
  full real history); the passive startup "Recent sessions" glance-panel has a cosmetic
  loading-race quirk, not a real data issue.
- Not yet done: SwitchYard router integration, full three-provider demo run back-to-back.

---

## v2 — 2026-08-22 — Container runtime switched: Docker Desktop → Colima

### Description
Deliberate infrastructure change, not a side effect of debugging: hit a **disk space issue
on the internal/root volume**, traced to Docker Desktop (its VM backing store lives on the
boot disk by default, regardless of where projects/images actually point). In a prior,
separate session, migrated the container runtime to **Colima** (Lima-VM-based) — lower
overhead, and its VM/data directory can be pointed anywhere via `COLIMA_HOME` (here,
`/Volumes/T7/Colima`, off the root volume entirely) — and removed Docker Desktop. Everything
from v1 (the multi-provider `pi` setup, the diagrams, the provider abstraction) is
unchanged — this entry only concerns the layer underneath `docker compose`.

Note: a stray old `Docker.app` copy was still found at `/Volumes/T7/DEV/docker/` during
this session's troubleshooting, left over from that migration — worth a cleanup pass if
it's not meant to still be there.

The switch surfaced several gaps that had been silently papered over by Docker Desktop's
GUI app self-managing things, worth recording since they're exactly the kind of "worked by
accident" issues that bite later:

- **CLI plugin resolution.** Docker Desktop manages `~/.docker/cli-plugins/` (symlinks into
  its own app bundle) and self-heals them on launch. Colima doesn't run a GUI app to do
  this — `docker-compose` and `docker-buildx` need to be installed as their own Homebrew
  formulae, plus `cliPluginsExtraDirs` added to `~/.docker/config.json` pointing at
  Homebrew's plugin directory so the `docker` CLI knows to look there.
- **Credential helper.** `~/.docker/config.json`'s `credsStore` defaulted to `"desktop"`
  (a Docker-Desktop-only binary). Switched to `"osxkeychain"` (via
  `brew install docker-credential-helper`).
- **Docker context / socket path.** Colima manages its own `docker context` named
  `colima`; if that context's endpoint drifts from where the running instance actually put
  its socket (e.g. after manually creating a new instance without the right home
  directory), everything fails with generic-looking connection errors.
- **The real one — VM mount scope.** Lima VMs only mount `$HOME` (and a couple of default
  paths) into themselves by default. A project living outside `$HOME` (here, on an
  external SSD at `/Volumes/T7`) gets a **silently empty bind mount** inside every
  container — `docker compose run` succeeds, `/work` exists, but it's empty. No error,
  just nothing there. Fixed with `colima start --mount /Volumes/T7:w`, which persists in
  Colima's saved config for future starts.

`host.docker.internal` (used by the Ollama extension to reach the host) continued to work
identically under Colima — that resolution mechanism isn't Docker-Desktop-specific.

### Known-good state at this version
- Colima running with `/Volumes/T7` mounted (writable), `COLIMA_HOME=/Volumes/T7/Colima`
  (already set in `.zshrc`).
- `docker compose build`/`run` confirmed working from `pi-multi-provider/` on Colima.
- Full end-to-end re-verified post-switch: `fd`/`rg` present, `ollama` extension loads,
  both local models register, real completion via `pi --provider ollama --model
  llama3.2:1b` returns actual output.
