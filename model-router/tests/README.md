# Tests

## test-custom-routing.sh

Exercises `routes.smart-v2` in `routes.toml` — the `mode = "custom"`
`llm_classifier` route that picks between three task-specialized targets
(`local`, `coding`, `cloud`) based on what the prompt actually asks for,
rather than the plain weak/strong capability split `routes.smart` uses.

Three cases, one per target:

| Case | Prompt | Expected target | Expected model |
|---|---|---|---|
| trivial | "say hello in exactly 3 words" | `local` | `llama3.1:8b` (Ollama) |
| coding | reverse-a-linked-list | `coding` | `mistral.devstral-2-123b` (Bedrock) |
| reasoning | prove infinitude of primes | `cloud` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (NVIDIA NIM) |

### Run it

```bash
docker compose exec pi bash tests/test-custom-routing.sh
# or, for a fresh one-off container:
docker compose run --rm pi bash tests/test-custom-routing.sh
```

Exits `0` if all three land on the expected model, `1` otherwise, with the
actual response body printed for anything that failed.

### What this does and doesn't prove

It proves the classifier is reading prompt *content* and routing
accordingly — a coding request and a reasoning request genuinely land on
different, correctly-specialized backends, not a coin flip and not
`default_target` silently catching everything. That's the thing worth
being suspicious of with any "LLM picks the best model" claim: this test
is the receipt.

It does **not** prove the judge's classification is *correct* in some
absolute sense, or that it will always classify the same way for prompts it
hasn't seen. The judge (`llama3.1:8b`, reused as `classifier_target`) is
itself an LLM making a judgment call — asking it to classify an ambiguous
or mixed-intent prompt (e.g. "write a function and also prove it's
correct") is a legitimate case where the answer could reasonably go either
way, and that's a property of the classifier design, not a test bug. Rerun
a few times if you want a feel for how stable the three cases above are in
practice — they've been consistently correct across repeated manual runs,
but this script checks one sample of each, not a distribution.

### Failure modes seen while building this

Both of the following were real, not hypothetical — see `routes.toml`'s
comments on `[targets.coding]` for the full story:

- **Wrong model ID for the target.** The classifier calls the target it
  picked; if that target's `id` is stale (model retired upstream) or
  simply wrong, the whole request fails with an upstream error — the
  classifier's own decision was still correct. Check `.switchyard.log` for
  a `routing decision` line before assuming the classifier is at fault.
- **Config not reloaded.** `switchyard-server` reads `routes.toml` once at
  startup; editing the file while the container is already running does
  nothing until it's restarted (`docker compose restart pi`).

## test-vision-route.sh

Exercises `routes.vision` — a plain passthrough to
`meta/llama-3.2-11b-vision-instruct` (NVIDIA NIM). Unlike `routes.smart-v2`,
this is **not** picked by any classifier — none of the text targets or the
smart-v2 judge were ever checked against image input, so this is a
deliberately manual-switch model: you point at it yourself when you have an
image or screenshot to hand it.

Generates a small solid-red PNG in-script (no fixture file, no image-library
dependency — just `python3`'s stdlib `zlib`), then checks two paths against
the same target:

| Check | Path | Proves |
|---|---|---|
| curl direct | raw HTTP to Switchyard's `/v1/chat/completions` with `model: "vision"` | the route/target wiring, and that the model actually reads image content |
| `pi --no-tools` | `pi --no-tools --provider switchyard --model vision -p "..." @image.png` | the real user-facing path works, not just raw HTTP |

### Run it

```bash
docker compose exec pi bash tests/test-vision-route.sh
# or, for a fresh one-off container:
docker compose run --rm pi bash tests/test-vision-route.sh
```

### Known limitation: `--no-tools` is required

Calling `routes.vision` from a normal `pi` session (full tool-schema system
prompt, tools enabled) fails with:

```
The number of image tokens (0) must be the same as the number of images (1)
```

This is NVIDIA's vLLM-hosted Llama-3.2-Vision (mllama architecture)
miscounting image placeholder tokens once pi's large tool-schema system
prompt is in the request — confirmed by the exact same image succeeding via
plain curl (no tools involved) and failing only through `pi` with tools
enabled. It's an upstream vLLM/mllama quirk, not a Switchyard routing bug or
a config error: `--no-tools` shrinks the system prompt enough to avoid it,
and you don't need tools to describe an image anyway. If this ever needs
tools *and* vision in the same call, that's a real open problem, not
something this route currently solves.
