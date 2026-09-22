#!/usr/bin/env node
// A small, always-running viewer over math-server/docs-server's own call
// log — not a one-shot generator, same pattern as trace-server.mjs (which
// does this for switchyard-server's routing log). math-server/docs-server
// already record every tool call unconditionally (mcp-calls.jsonl, via
// log-call.mjs); this just reparses that file fresh on every page load.
//
// Deliberately a separate file/page from trace-server.mjs rather than a
// second parser bolted onto it: the two logs have unrelated shapes (LLM
// routing decisions vs. MCP tool calls), so keeping them apart keeps each
// viewer simple instead of teaching one viewer two log formats.
//
// Run once, leave running (already wired into entrypoint.sh):
//   node mcp-trace-server.mjs
// Then: http://localhost:4322/ — every math/docs tool call seen so far,
// newest first, auto-refreshing.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const LOG_FILE = "/work/logs/mcp-calls.jsonl";
const PORT = 4322;

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Reparsed on every request rather than cached/streamed incrementally —
// deliberately simple for a demo-scale log, same tradeoff trace-server.mjs
// makes for switchyard-routing.jsonl.
function loadCalls() {
  return safeRead(LOG_FILE)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .reverse(); // newest first
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Same palette as trace-server.mjs, so the two viewers read as one system.
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
.sub code { font-family: var(--mono); font-size: 0.88em; color: var(--text); background: var(--accent-dim); padding: 0.05em 0.35em; border-radius: 3px; }
h2 { font-size: 0.8rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.7rem; font-weight: 650; }
.list { border: 1px solid var(--panel-line); border-radius: 10px; overflow: hidden; background: var(--panel); }
.list-row { display: grid; grid-template-columns: 12rem 4.5rem 7rem 1fr 5rem 6rem; gap: 0.9rem; align-items: center; padding: 0.7rem 1rem; border-bottom: 1px solid var(--panel-line); font-size: 0.88rem; }
.list-row:last-child { border-bottom: none; }
.list-row.head { font-family: var(--mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.list-t { font-family: var(--mono); font-size: 0.76rem; color: var(--muted); }
.list-server { font-family: var(--mono); font-size: 0.82rem; color: var(--flow); }
.list-tool code { font-family: var(--mono); background: var(--accent-dim); padding: 0.02em 0.3em; border-radius: 3px; }
.list-result { font-family: var(--mono); font-size: 0.8rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-status.good { color: var(--good); font-family: var(--mono); }
.list-status.bad { color: #e5484d; font-family: var(--mono); }
.list-dur { font-family: var(--mono); color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 2rem 1rem; text-align: center; font-size: 0.9rem; }
footer { color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--panel-line); padding-top: 1.1rem; }
`;

function page(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="page">${body}</div></body>
</html>`;
}

function renderIndex(calls) {
  const rows = calls
    .slice(0, 200)
    .map((c) => {
      const ok = !c.isError;
      return `    <div class="list-row">
      <span class="list-t">${esc(c.ts)}</span>
      <span class="list-server">${esc(c.server)}</span>
      <span class="list-tool"><code>${esc(c.tool)}</code></span>
      <span class="list-result" title="${esc(JSON.stringify(c.args))}">${esc(JSON.stringify(c.args))}</span>
      <span class="list-status ${ok ? "good" : "bad"}">${ok ? "ok" : "error"}</span>
      <span class="list-dur">${Number(c.durationMs).toFixed(0)} ms</span>
    </div>`;
    })
    .join("\n");

  const body = `
  <header>
    <div class="eyebrow">mcp · math-server + docs-server · call history</div>
    <h1>Every direct MCP tool call, not just the last one</h1>
    <p class="sub">
      Reconstructed live from <code>mcp-calls.jsonl</code> on every page load — this
      page refreshes itself every 5s. ${calls.length} call${calls.length === 1 ? "" : "s"} seen
      so far (showing up to 200, newest first).
    </p>
  </header>
  <section>
    <div class="list">
      <div class="list-row head"><span>time</span><span>server</span><span>tool</span><span>args</span><span>status</span><span>duration</span></div>
${rows || `      <div class="empty">No calls yet — hit <code>math</code> or <code>docs</code> through <code>pi</code> and this list fills in.</div>`}
    </div>
  </section>
  <footer>Source: <code>mcp/mcp-calls.jsonl</code></footer>`;

  return page("MCP Call History", body);
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderIndex(loadCalls()));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(PORT, () => console.log(`mcp-trace-server listening on :${PORT}`));
