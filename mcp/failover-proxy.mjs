#!/usr/bin/env node
// Sits in front of switchyard-server, on its own port. switchyard-server has
// no concept of "this target failed, try a different provider" — its
// classifier only decides which target to dial *before* the call, based on
// task complexity, not availability. This file is that missing layer: try
// Switchyard's own classifier-driven route first (covers local Ollama vs.
// cloud NVIDIA as usual), and only on a non-2xx response or network error,
// retry the *same* request against Bedrock/OpenAI targets in order —
// cheapest first, most capable last — by asking Switchyard for a different
// route (`model` field), not by calling those providers directly. That way
// every attempt, including the failed ones, still lands in
// switchyard-routing.jsonl / .switchyard.log — the trace viewer and Grafana
// dashboard see fallback activity the same way they see everything else.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = 4100;
const UPSTREAM = "http://127.0.0.1:4000/v1/chat/completions";
const FAILOVER_LOG = "/work/failover.jsonl";

// Order matters: routes.smart first (nvidia/ollama via the classifier),
// then one more free rung (a bigger local model — slower, but still $0,
// worth trying before spending anything), then Bedrock cheapest-to-most-
// capable — gpt-oss-20b, then GLM-5. Nova and Claude Sonnet aren't here:
// Nova isn't reachable via any Switchyard-compatible format at all, and
// Claude Sonnet is blocked on this account's Bedrock model-access grant
// (see routes.toml). "openai-gpt51" isn't here either — no real
// OPENAI_API_KEY in .env yet, and routes.toml doesn't define that route
// for the same reason. Add it back once there's a real key.
const CHAIN = [
  "switchyard",
  "local-big",
  "bedrock-gptoss",
  "bedrock-glm",
];

function log(entry) {
  try {
    appendFileSync(FAILOVER_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // best-effort; never let logging break the actual response
  }
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    // A single client-visible model, "auto" — distinct from Switchyard's own
    // "switchyard"/"local"/"cloud" (still reachable directly on :4000 for
    // manual testing). Calling "auto" is what actually engages this chain.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "auto", object: "model" }] }));
    return;
  }

  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("invalid json body");
    return;
  }

  const attempts = [];
  for (const model of CHAIN) {
    let upstreamRes;
    try {
      upstreamRes = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, model }),
      });
    } catch (err) {
      attempts.push({ model, ok: false, error: String(err?.message ?? err) });
      continue;
    }

    if (upstreamRes.ok) {
      attempts.push({ model, ok: true, status: upstreamRes.status });
      log({ chain: CHAIN, attempts, chosen: model });
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") || "application/json",
      });
      for await (const chunk of upstreamRes.body) res.write(chunk);
      res.end();
      return;
    }

    const errBody = await upstreamRes.text().catch(() => "");
    attempts.push({ model, ok: false, status: upstreamRes.status, body: errBody.slice(0, 300) });
  }

  log({ chain: CHAIN, attempts, chosen: null });
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "every target in the failover chain failed", attempts }));
}).listen(PORT, () => console.log(`failover-proxy listening on :${PORT}`));
