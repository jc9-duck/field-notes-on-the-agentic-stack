#!/usr/bin/env node
// A small, always-running viewer over switchyard's own logs — not a
// one-shot generator. switchyard-server already records every request
// unconditionally (switchyard-routing.jsonl + .switchyard.log); this just
// reconstructs full request history from those two files on every page
// load and lets you browse any past request, not only the latest one.
//
// Run once, leave running (already wired into entrypoint.sh):
//   node trace-server.mjs
// Then: http://localhost:4321/ — an index of every request seen so far,
// newest first, auto-refreshing. Click one to see its hop ledger.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const ROUTING_LOG = "/work/switchyard-routing.jsonl";
const DEBUG_LOG = "/work/.switchyard.log";
const MERMAID_JS = "/opt/mermaid/node_modules/mermaid/dist/mermaid.min.js";
const PORT = 4321;

const DECISION_RE = /^(\S+)Z DEBUG.*routing decision algorithm="([^"]*)" selected_model="([^"]*)" reasoning="([^"]*)"/gm;
const HANDLED_RE = /^(\S+)Z\s+INFO.*LLM request handled wire_format=(\S+) status=(\d+) requested_model="([^"]*)" selected_model="([^"]*)".*handling_duration_ms=([\d.]+)/gm;

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function nearest(matches, targetMs, toleranceMs = 5000) {
  let best = null;
  let bestDelta = Infinity;
  for (const m of matches) {
    const ms = Date.parse(`${m[1]}Z`);
    const delta = Math.abs(ms - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = m;
    }
  }
  return best && bestDelta <= toleranceMs ? best : null;
}

// Reparsed on every request rather than cached/streamed incrementally —
// deliberately simple for a demo-scale log; swap for a tail -f-style
// incremental reader if these files ever get large.
function loadRequests() {
  const routingLines = safeRead(ROUTING_LOG).trim().split("\n").filter(Boolean);
  const records = routingLines.map((l) => JSON.parse(l));
  const debugLog = safeRead(DEBUG_LOG);
  const decisionMatches = [...debugLog.matchAll(DECISION_RE)];
  const handledMatches = [...debugLog.matchAll(HANDLED_RE)];

  const requests = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.tier === "classifier") continue; // consumed below when paired with its served record
    const prev = records[i - 1];
    const classifier = prev && prev.tier === "classifier" ? prev : null;
    const servedMs = Date.parse(rec.ts);
    const decision = classifier ? nearest(decisionMatches, Date.parse(classifier.ts)) : null;
    const handled = nearest(handledMatches, servedMs);
    requests.push({ id: rec.ts, classifier, served: rec, decision, handled });
  }
  return requests.reverse(); // newest first
}

function whoServes(model) {
  return model.startsWith("nvidia/")
    ? "switchyard → nvidia"
    : "switchyard → ollama";
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Mermaid label text: strip quotes/colons/newlines rather than escape them —
// those characters have syntactic meaning inside sequenceDiagram messages
// and notes, so escaping wouldn't help; the label just needs to read fine
// stripped down, not survive round-trip.
function mermaidLabel(s) {
  return String(s).replace(/[":\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
}

function mermaidFor(r) {
  const cUp = r.classifier ? (whoServes(r.classifier.model).includes("nvidia") ? "nvidia" : "ollama") : null;
  const sUp = whoServes(r.served.model).includes("nvidia") ? "nvidia" : "ollama";
  const upstreams = [...new Set([cUp, sUp].filter(Boolean))];
  const idFor = (name) => (name === "nvidia" ? "N" : "O");

  const lines = ["sequenceDiagram", "    participant P as pi", "    participant S as switchyard"];
  for (const up of upstreams) lines.push(`    participant ${idFor(up)} as ${up}`);

  lines.push("    P->>S: POST /v1/chat/completions (model=switchyard)");
  if (r.classifier) {
    const cid = idFor(cUp);
    lines.push(`    S->>${cid}: classify (${mermaidLabel(r.classifier.model)})`);
    lines.push(`    ${cid}-->>S: ${r.classifier.completion_tokens} completion tokens`);
    lines.push(`    Note over S: ${mermaidLabel(r.decision ? r.decision[4] : "routing decision")}`);
  }
  const sid = idFor(sUp);
  lines.push(`    S->>${sid}: ${r.classifier ? "actual request" : "request"} (${mermaidLabel(r.served.model)})`);
  lines.push(`    ${sid}-->>S: ${r.served.completion_tokens} completion tokens`);
  lines.push(`    S-->>P: status=${r.handled ? r.handled[3] : "?"}`);
  return lines.join("\n");
}

const STYLE = `
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
.page { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 2rem; }
.eyebrow { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--flow); }
h1 { font-size: clamp(1.5rem, 3vw, 2rem); margin: 0.3rem 0 0.5rem; text-wrap: balance; font-weight: 650; }
.sub { color: var(--muted); max-width: 68ch; font-size: 0.96rem; }
.sub code, a code { font-family: var(--mono); font-size: 0.88em; color: var(--text); background: var(--accent-dim); padding: 0.05em 0.35em; border-radius: 3px; }
a { color: var(--flow); text-decoration: none; }
a:hover { text-decoration: underline; }
.back { font-family: var(--mono); font-size: 0.8rem; }
.meta-row { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 0.9rem; }
.chip { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); border: 1px solid var(--panel-line); background: var(--panel); border-radius: 5px; padding: 0.3rem 0.6rem; }
.chip b { color: var(--text); }
.chip .good { color: var(--good); }
h2 { font-size: 0.8rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.7rem; font-weight: 650; }
.ledger, .list { border: 1px solid var(--panel-line); border-radius: 10px; overflow: hidden; background: var(--panel); }
.ledger-row { display: grid; grid-template-columns: 2.4rem 12rem 1fr auto; gap: 0.9rem; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid var(--panel-line); font-size: 0.9rem; }
.ledger-row:last-child { border-bottom: none; }
.hop-n { font-family: var(--mono); color: var(--accent); font-weight: 700; }
.hop-t { font-family: var(--mono); font-size: 0.74rem; color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hop-desc .who { font-family: var(--mono); font-size: 0.82rem; color: var(--flow); }
.hop-desc code { font-family: var(--mono); background: var(--accent-dim); padding: 0.02em 0.3em; border-radius: 3px; }
.hop-stat { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.list-row { display: grid; grid-template-columns: 12rem 1fr 5rem 4rem 6rem; gap: 0.9rem; align-items: center; padding: 0.7rem 1rem; border-bottom: 1px solid var(--panel-line); font-size: 0.88rem; }
.list-row:last-child { border-bottom: none; }
.list-row.head { font-family: var(--mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.list-t { font-family: var(--mono); font-size: 0.76rem; color: var(--muted); }
.list-model code { font-family: var(--mono); background: var(--accent-dim); padding: 0.02em 0.3em; border-radius: 3px; }
.list-status.good { color: var(--good); font-family: var(--mono); }
.list-status.bad { color: #e5484d; font-family: var(--mono); }
.list-dur { font-family: var(--mono); color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 2rem 1rem; text-align: center; font-size: 0.9rem; }
.diagram-wrap { background: var(--panel); border: 1px solid var(--panel-line); border-radius: 10px; padding: 1.2rem 1rem 0.4rem; overflow-x: auto; }
.diagram-wrap pre.mermaid { margin: 0; }
footer { color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--panel-line); padding-top: 1.1rem; }
`;

// Mermaid renders client-side from the bundled dist/mermaid.min.js (served
// below at /static/mermaid.min.js) — no headless-browser dependency in this
// image just to draw one diagram, and no external CDN call either.
const MERMAID_SETUP = `
<script src="/static/mermaid.min.js"></script>
<script>
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "default" });
</script>`;

function page(title, body, refresh) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="page">${body}</div>${MERMAID_SETUP}</body>
</html>`;
}

function renderIndex(requests) {
  const rows = requests
    .slice(0, 100)
    .map((r) => {
      const status = r.handled ? r.handled[3] : "?";
      const ok = status === "200";
      return `    <a class="list-row" href="/trace/${encodeURIComponent(r.id)}">
      <span class="list-t">${esc(r.served.ts)}</span>
      <span class="list-model"><code>${esc(r.served.model)}</code></span>
      <span>${esc(r.served.tier)}</span>
      <span class="list-status ${ok ? "good" : "bad"}">${esc(status)}</span>
      <span class="list-dur">${r.handled ? Number(r.handled[6]).toFixed(0) + " ms" : "—"}</span>
    </a>`;
    })
    .join("\n");

  const body = `
  <header>
    <div class="eyebrow">model-router · switchyard-server · request history</div>
    <h1>Every request, not just the last one</h1>
    <p class="sub">
      Reconstructed live from <code>switchyard-routing.jsonl</code> +
      <code>.switchyard.log</code> on every page load — this page refreshes itself every 5s.
      ${requests.length} request${requests.length === 1 ? "" : "s"} seen so far (showing up to 100, newest first).
    </p>
  </header>
  <section>
    <div class="list">
      <div class="list-row head"><span>time</span><span>model</span><span>tier</span><span>status</span><span>duration</span></div>
${rows || `      <div class="empty">No requests yet — run one through <code>pi</code> and this list fills in.</div>`}
    </div>
  </section>
  <footer>Source: <code>model-router/switchyard-routing.jsonl</code> · <code>model-router/.switchyard.log</code></footer>`;

  return page("SwitchYard Request History", body, 5);
}

function renderDetail(r) {
  const hops = [];
  if (r.classifier) {
    hops.push({
      ts: r.classifier.ts,
      who: whoServes(r.classifier.model),
      desc: `classifier call, model <code>${esc(r.classifier.model)}</code>`,
      stat: `${r.classifier.prompt_tokens} in / ${r.classifier.completion_tokens} out`,
    });
    hops.push({
      ts: r.decision ? `${r.decision[1]}Z` : "—",
      who: "switchyard (internal)",
      desc: `routing decision: <em>&ldquo;${r.decision ? esc(r.decision[4]) : "n/a"}&rdquo;</em>`,
      stat: `algorithm: ${r.decision ? esc(r.decision[2]) : "n/a"}`,
    });
  }
  hops.push({
    ts: r.served.ts,
    who: whoServes(r.served.model),
    desc: `${r.classifier ? "actual request" : "request"}, tier <code>${esc(r.served.tier)}</code>, model <code>${esc(r.served.model)}</code>`,
    stat: `${r.served.prompt_tokens} in / ${r.served.completion_tokens} out`,
  });
  hops.push({
    ts: r.handled ? `${r.handled[1]}Z` : "—",
    who: "switchyard → pi",
    desc: `response handed back, <code>status=${r.handled ? esc(r.handled[3]) : "?"}</code>`,
    stat: r.handled ? `${Number(r.handled[6]).toFixed(1)} ms total` : "—",
  });

  const rows = hops
    .map(
      (h, i) => `    <div class="ledger-row">
      <span class="hop-n">${i + 1}</span>
      <span class="hop-t">${esc(h.ts)}</span>
      <span class="hop-desc"><span class="who">${esc(h.who)}</span> — ${h.desc}</span>
      <span class="hop-stat">${h.stat}</span>
    </div>`
    )
    .join("\n");

  const body = `
  <header>
    <p class="back"><a href="/">&larr; All requests</a></p>
    <div class="eyebrow">model-router · switchyard-server · request trace</div>
    <h1>Request at ${esc(r.served.ts)}</h1>
    <div class="meta-row">
      <span class="chip">selected_model <b>${esc(r.served.model)}</b></span>
      <span class="chip">tier <b>${esc(r.served.tier)}</b></span>
      <span class="chip">status <b class="good">${r.handled ? esc(r.handled[3]) : "?"}</b></span>
      <span class="chip">total duration <b>${r.handled ? Number(r.handled[6]).toFixed(1) : "?"} ms</b></span>
    </div>
  </header>
  <section>
    <h2>Sequence</h2>
    <div class="diagram-wrap">
<pre class="mermaid">
${esc(mermaidFor(r))}
</pre>
    </div>
  </section>
  <section>
    <h2>Hop ledger</h2>
    <div class="ledger">
${rows}
    </div>
  </section>`;

  return page(`Trace ${r.served.ts}`, body);
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/static/mermaid.min.js") {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" });
    res.end(safeRead(MERMAID_JS));
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderIndex(loadRequests()));
    return;
  }
  if (url.pathname.startsWith("/trace/")) {
    const id = decodeURIComponent(url.pathname.slice("/trace/".length));
    const found = loadRequests().find((r) => r.id === id);
    res.writeHead(found ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(found ? renderDetail(found) : page("Not found", "<p>No request with that id.</p>"));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(PORT, () => console.log(`trace-server listening on :${PORT}`));
