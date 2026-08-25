#!/usr/bin/env node
// Regenerates a self-contained HTML trace of the most recent request that
// went through switchyard-server, built from the same two artifacts anyone
// following along has: switchyard-routing.jsonl (structured, one record per
// model call) and .switchyard.log (RUST_LOG=debug trace). No external
// libraries, no network calls — just parse and render.
//
// Usage (from inside the model-router container, after at least one `pi`
// request has gone through the router):
//   node render-trace.mjs
// Writes /work/trace.html — open it from the host at model-router/trace.html.

import { readFileSync, writeFileSync } from "node:fs";

const ROUTING_LOG = "/work/switchyard-routing.jsonl";
const DEBUG_LOG = "/work/.switchyard.log";
const OUT = "/work/trace.html";

function fail(msg) {
  console.error(`render-trace: ${msg}`);
  process.exit(1);
}

let routingLines;
try {
  routingLines = readFileSync(ROUTING_LOG, "utf8").trim().split("\n").filter(Boolean);
} catch {
  fail(`couldn't read ${ROUTING_LOG} — run a pi request through switchyard first.`);
}
if (routingLines.length === 0) fail(`${ROUTING_LOG} is empty — run a pi request through switchyard first.`);

const records = routingLines.map((l) => JSON.parse(l));
const served = records.at(-1);
const prev = records.at(-2);
// A classified request writes two records back-to-back (classifier tier,
// then weak/strong); a forced passthrough route (local/cloud) writes just
// one. Recency is enough to pair them correctly for a single-shot demo run
// like this — it doesn't try to disentangle concurrent overlapping requests.
const classifier = prev && prev.tier === "classifier" && prev.model !== served.model ? prev : prev && prev.tier === "classifier" ? prev : null;

const debugLog = (() => {
  try {
    return readFileSync(DEBUG_LOG, "utf8");
  } catch {
    return "";
  }
})();

const decisionMatches = [...debugLog.matchAll(
  /^(\S+)Z DEBUG.*routing decision algorithm="([^"]*)" selected_model="([^"]*)" reasoning="([^"]*)"/gm
)];
const handledMatches = [...debugLog.matchAll(
  /^(\S+)Z\s+INFO.*LLM request handled wire_format=(\S+) status=(\d+) requested_model="([^"]*)" selected_model="([^"]*)".*handling_duration_ms=([\d.]+)/gm
)];

const decision = decisionMatches.at(-1);
const handled = handledMatches.at(-1);

function whoServes(model) {
  return model.startsWith("nvidia/")
    ? { label: "NVIDIA NIM (cloud)", who: "switchyard → nvidia" }
    : { label: "Ollama (host.docker.internal)", who: "switchyard → ollama" };
}

const hops = [];
if (classifier) {
  hops.push({
    ts: `${classifier.ts}`,
    who: whoServes(classifier.model).who,
    desc: `classifier call, model <code>${classifier.model}</code>`,
    stat: `${classifier.prompt_tokens} in / ${classifier.completion_tokens} out`,
  });
  hops.push({
    ts: decision ? `${decision[1]}Z` : "—",
    who: "switchyard (internal)",
    desc: `routing decision: <em>&ldquo;${decision ? decision[4] : "n/a"}&rdquo;</em>`,
    stat: `algorithm: ${decision ? decision[2] : "n/a"}`,
  });
}
hops.push({
  ts: `${served.ts}`,
  who: whoServes(served.model).who,
  desc: `${classifier ? "actual request" : "request"}, tier <code>${served.tier}</code>, model <code>${served.model}</code>`,
  stat: `${served.prompt_tokens} in / ${served.completion_tokens} out`,
});
hops.push({
  ts: handled ? `${handled[1]}Z` : "—",
  who: "switchyard → pi",
  desc: `response handed back, <code>status=${handled ? handled[3] : "?"}</code>`,
  stat: handled ? `${Number(handled[6]).toFixed(1)} ms total` : "—",
});

const rows = hops
  .map(
    (h, i) => `    <div class="ledger-row">
      <span class="hop-n">${i + 1}</span>
      <span class="hop-t">${h.ts}</span>
      <span class="hop-desc"><span class="who">${h.who}</span> — ${h.desc}</span>
      <span class="hop-stat">${h.stat}</span>
    </div>`
  )
  .join("\n");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>SwitchYard Request Trace</title>
<style>
:root {
  --bg: #0b0f14; --panel: #10161e; --panel-line: #1e2733; --text: #dbe4ea;
  --muted: #7d8fa0; --accent: #ff9d4d; --accent-dim: #ff9d4d33; --flow: #5ec8d8; --good: #6fcf97;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, "Inter", "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f3f5f7; --panel: #fff; --panel-line: #dde3e9; --text: #1a2430;
    --muted: #5c6b7a; --accent: #c25a00; --accent-dim: #c25a0022; --flow: #0d7a8f; --good: #1f8a53;
  }
}
:root[data-theme="light"] {
  --bg: #f3f5f7; --panel: #fff; --panel-line: #dde3e9; --text: #1a2430;
  --muted: #5c6b7a; --accent: #c25a00; --accent-dim: #c25a0022; --flow: #0d7a8f; --good: #1f8a53;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--sans); margin: 0; padding: 2.5rem 1.5rem 4rem; line-height: 1.55; }
.page { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 2rem; }
.eyebrow { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--flow); }
h1 { font-size: clamp(1.5rem, 3vw, 2rem); margin: 0.3rem 0 0.5rem; text-wrap: balance; font-weight: 650; }
.sub { color: var(--muted); max-width: 62ch; font-size: 0.96rem; }
.sub code { font-family: var(--mono); font-size: 0.88em; color: var(--text); background: var(--accent-dim); padding: 0.05em 0.35em; border-radius: 3px; }
.meta-row { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 0.9rem; }
.chip { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); border: 1px solid var(--panel-line); background: var(--panel); border-radius: 5px; padding: 0.3rem 0.6rem; }
.chip b { color: var(--text); }
.chip .good { color: var(--good); }
h2 { font-size: 0.8rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.7rem; font-weight: 650; }
.ledger { border: 1px solid var(--panel-line); border-radius: 10px; overflow: hidden; background: var(--panel); }
.ledger-row { display: grid; grid-template-columns: 2.4rem 12rem 1fr auto; gap: 0.9rem; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid var(--panel-line); font-size: 0.9rem; }
.ledger-row:last-child { border-bottom: none; }
.hop-n { font-family: var(--mono); color: var(--accent); font-weight: 700; }
.hop-t { font-family: var(--mono); font-size: 0.74rem; color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hop-desc .who { font-family: var(--mono); font-size: 0.82rem; color: var(--flow); }
.hop-desc code { font-family: var(--mono); background: var(--accent-dim); padding: 0.02em 0.3em; border-radius: 3px; }
.hop-stat { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.evidence { font-family: var(--mono); font-size: 0.74rem; color: var(--muted); background: var(--panel); border: 1px solid var(--panel-line); border-radius: 8px; padding: 0.85rem 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
footer { color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--panel-line); padding-top: 1.1rem; }
footer code { font-family: var(--mono); background: var(--accent-dim); padding: 0.05em 0.35em; border-radius: 3px; color: var(--text); }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="eyebrow">model-router · switchyard-server · request trace</div>
    <h1>Latest request, hop by hop</h1>
    <p class="sub">
      Regenerated by <code>render-trace.mjs</code> straight from
      <code>switchyard-routing.jsonl</code> and <code>.switchyard.log</code> — whatever
      the most recent <code>pi</code> request through this router actually did. Run another
      request, then re-run this script, and it changes.
    </p>
    <div class="meta-row">
      <span class="chip">selected_model <b>${served.model}</b></span>
      <span class="chip">tier <b>${served.tier}</b></span>
      <span class="chip">status <b class="good">${handled ? handled[3] : "?"}</b></span>
      <span class="chip">total duration <b>${handled ? Number(handled[6]).toFixed(1) : "?"} ms</b></span>
    </div>
  </header>

  <section>
    <h2>Hop ledger</h2>
    <div class="ledger">
${rows}
    </div>
  </section>

  <section>
    <h2>Evidence</h2>
    <div class="evidence">$ tail -${classifier ? 2 : 1} switchyard-routing.jsonl
${classifier ? JSON.stringify(classifier) + "\n" : ""}${JSON.stringify(served)}</div>
  </section>

  <footer>
    Source: <code>model-router/switchyard-routing.jsonl</code> ·
    <code>model-router/.switchyard.log</code> — regenerate with
    <code>node render-trace.mjs</code> after any new request.
  </footer>
</div>
</body>
</html>
`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
