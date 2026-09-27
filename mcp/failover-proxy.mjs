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
// qwen-coder (Qwen3-Coder-Next) inserted right after switchyard's own
// classifier attempt: 77.2% vs Devstral's 72.2% on SWE-bench Verified, at a
// comparable Bedrock price ($0.50/M vs $0.40/M input) -- the better default
// coding fallback once switchyard's own pick fails. Same preference applied
// in pi-dev's chain.
const CHAIN = [
  "switchyard",
  "qwen-coder",
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

// NVIDIA has been observed sending a mid-stream `{"error":{...}}` SSE frame
// inside an otherwise-2xx response (a ResourceExhausted rate-limit that
// arrives *after* the HTTP status/headers are already committed) -- from
// `upstreamRes.ok`'s perspective that's a plain success, so without this
// check the chain below would forward the error straight to pi and never
// try the next target. Peeks the first SSE event on `text/event-stream`
// responses only (a non-streaming 200 has no "mid-stream" to speak of);
// returns `{ ok: true, reader, prelude }` so the caller can resume reading
// from the same reader after replaying the already-consumed `prelude`
// bytes, or `{ ok: false, body }` with the upstream connection already
// aborted (`controller.abort()`, not just `reader.cancel()` -- confirmed by
// test that `cancel()` alone leaves the underlying socket open server-side
// until the provider's own timeout, which is exactly the abandoned-request
// pattern behind the observed "ResourceExhausted 16/16" climbing past 16).
async function peekSseError(upstreamRes, controller) {
  const contentType = upstreamRes.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    return { ok: true, reader: null, prelude: null };
  }
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  // Read until one full SSE event (blank-line-terminated) or a sanity cap,
  // in case a malformed stream never sends a terminator.
  while (!buffered.includes("\n\n") && buffered.length < 8192) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  const firstEvent = buffered.split("\n\n")[0] || buffered;
  for (const line of firstEvent.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.error) {
        controller.abort();
        return { ok: false, body: buffered.slice(0, 300) };
      }
    } catch {
      // Not JSON, or truncated mid-token -- a real content chunk, not an
      // error signal. Fall through and treat this attempt as good.
    }
  }
  return { ok: true, reader, prelude: buffered ? Buffer.from(buffered, "utf8") : null };
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

  // If pi (or the eval harness's `timeout`) gives up and disconnects while
  // an upstream call is still in flight, abort that call rather than
  // leaving it running unattended -- an abandoned request still occupies a
  // slot against NVIDIA's per-account concurrency limit, which is how a
  // "ResourceExhausted (16/16)" figure was observed climbing well past 16
  // over a session: every abandoned attempt kept holding its slot until the
  // provider's own timeout, not this proxy's.
  let responseSent = false;
  let currentAbort = null;
  let clientDisconnected = false;
  res.on("close", () => {
    if (!responseSent) {
      clientDisconnected = true;
      currentAbort?.abort();
    }
  });

  const attempts = [];
  for (const model of CHAIN) {
    if (clientDisconnected) break;
    const controller = new AbortController();
    currentAbort = controller;
    let upstreamRes;
    try {
      upstreamRes = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, model }),
        signal: controller.signal,
      });
    } catch (err) {
      attempts.push({ model, ok: false, error: String(err?.message ?? err) });
      continue;
    }
    if (clientDisconnected) break;

    // The client can disconnect at any point from here on (peeking or
    // forwarding the stream), which rejects/throws via the same
    // controller.signal -- catch that specifically so one client going away
    // doesn't take an unhandled rejection down through the whole server
    // (and every other in-flight request with it).
    try {
      if (upstreamRes.ok) {
        const peek = await peekSseError(upstreamRes, controller);
        if (peek.ok) {
          attempts.push({ model, ok: true, status: upstreamRes.status });
          log({ chain: CHAIN, attempts, chosen: model });
          res.writeHead(upstreamRes.status, {
            "content-type": upstreamRes.headers.get("content-type") || "application/json",
          });
          if (peek.prelude) res.write(peek.prelude);
          if (peek.reader) {
            while (true) {
              const { done, value } = await peek.reader.read();
              if (done) break;
              res.write(value);
            }
          } else {
            for await (const chunk of upstreamRes.body) res.write(chunk);
          }
          res.end();
          responseSent = true;
          return;
        }
        attempts.push({ model, ok: false, status: upstreamRes.status, body: peek.body, midStream: true });
        continue;
      }

      const errBody = await upstreamRes.text().catch(() => "");
      attempts.push({ model, ok: false, status: upstreamRes.status, body: errBody.slice(0, 300) });
    } catch (err) {
      if (clientDisconnected) break;
      attempts.push({ model, ok: false, error: String(err?.message ?? err) });
    }
  }

  if (clientDisconnected) {
    log({ chain: CHAIN, attempts, chosen: null, clientDisconnected: true });
    return;
  }

  log({ chain: CHAIN, attempts, chosen: null });
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "every target in the failover chain failed", attempts }));
  responseSent = true;
}).listen(PORT, () => console.log(`failover-proxy listening on :${PORT}`));
