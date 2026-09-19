# Runbook: API Latency Spike

## Symptoms
- p99 latency on `/v1/chat/completions` exceeds 5s
- Alert fires from the `api-latency-p99` Grafana panel

## Triage steps
1. Check `switchyard-routing.jsonl` for a recent shift in target selection —
   a misrouted burst to a slower model tier is the most common cause.
2. Check upstream provider status pages (Bedrock, NVIDIA NIM) for incidents.
3. If the local Ollama judge model is the bottleneck, restart the container —
   known issue where long-running Ollama processes leak GPU memory on macOS.

## Escalation
Page on-call only if latency stays above threshold for >15 minutes after step 3.
