// Structured per-call log, appended to a bind-mounted file so it's visible
// on the host (same convention as switchyard-routing.jsonl) and readable by
// mcp-trace-server.mjs running in the pi container. Duplicated into
// docs-server/ rather than shared, per this repo's self-contained-server
// convention -- each server folder has no dependency on its sibling.
import { appendFile } from "node:fs/promises";

const LOG_FILE = process.env.MCP_LOG_FILE ?? "/data/logs/mcp-calls.jsonl";

export async function logCall(server, tool, args, { durationMs, isError = false, result } = {}) {
  console.log(`[${server}] ${tool}(${JSON.stringify(args)})`);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    server,
    tool,
    args,
    durationMs: Math.round(durationMs),
    isError,
    result: result === undefined ? undefined : String(result).slice(0, 200),
  });
  try {
    await appendFile(LOG_FILE, line + "\n");
  } catch (err) {
    console.error(`failed to write mcp-calls log: ${err.message}`);
  }
}
