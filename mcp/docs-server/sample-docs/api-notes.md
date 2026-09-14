# Internal API Notes: /v1/route

Routes a chat completion request through whichever backend the classifier
selects. Not part of any public API surface — internal only.

## Request
```
POST /v1/route
{
  "messages": [...],
  "hint": "cost" | "quality" | null
}
```

## Known quirks
- `hint` is advisory only; the classifier can override it if confidence is low.
- Cold-start latency on the local Ollama target is ~2s the first call after a
  container restart, then drops to <200ms.
