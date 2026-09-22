#!/usr/bin/env node
// The point of this server is the asymmetry, not the implementation: it
// genuinely implements read/write/delete against real files in DOCS_DIR
// (bind-mounted from the host, see docker-compose.yml) — agentgateway's
// mcpAuthorization policy is what restricts the gateway to exposing only
// `read`. Calling this server directly (bypassing the gateway, e.g.
// `docker compose exec docs-server curl localhost:3002/mcp ...`) proves
// write/delete still work here; that's the whole demo in #22.
//
// Streamable HTTP (stateless), same reasoning as math-server/index.mjs:
// agentgateway's own container can't spawn this as a stdio subprocess.
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import { logCall } from "./log-call.mjs";

const DOCS_DIR = process.env.DOCS_DIR ?? "/data/sample-docs";

// Resolve+contain every filename under DOCS_DIR — this is a demo server,
// not a security boundary in itself (the gateway's tool-level restriction
// is the actual access control being demonstrated), but path traversal out
// of the mounted folder is still worth ruling out on principle.
function resolveDoc(filename) {
  const resolved = path.resolve(DOCS_DIR, filename);
  const root = path.resolve(DOCS_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refusing to access path outside ${DOCS_DIR}`);
  }
  return resolved;
}

// Wraps a tool body so a thrown error (missing file, path traversal, etc.)
// still gets logged before propagating -- without this, only successful
// calls would show up in mcp-trace-server.mjs, since registerTool's own
// error handling converts the throw into an isError response upstream of
// any logging we'd otherwise only do on the success path.
async function runTool(tool, args, fn) {
  const start = performance.now();
  try {
    const text = await fn();
    await logCall("docs", tool, args, { durationMs: performance.now() - start, result: text });
    return { content: [{ type: "text", text }] };
  } catch (err) {
    await logCall("docs", tool, args, { durationMs: performance.now() - start, isError: true, result: err.message });
    throw err;
  }
}

function buildServer() {
  const server = new McpServer({ name: "docs-server", version: "1.0.0" });

  server.registerTool(
    "read",
    {
      description: "Read a document by filename from the sample-docs folder. Omit filename to list available documents.",
      inputSchema: { filename: z.string().optional() },
    },
    ({ filename }) =>
      runTool("read", { filename: filename ?? "<list>" }, async () => {
        if (!filename) return (await readdir(DOCS_DIR)).join("\n");
        return readFile(resolveDoc(filename), "utf8");
      }),
  );

  server.registerTool(
    "write",
    {
      description: "Write (create or overwrite) a document in the sample-docs folder.",
      inputSchema: { filename: z.string(), content: z.string() },
    },
    // Logged as a byte count, not the raw content -- callers may write
    // arbitrarily large or sensitive text, and the point of the viewer is
    // to show what happened, not to double as a document store.
    ({ filename, content }) =>
      runTool("write", { filename, contentLength: content.length }, async () => {
        await writeFile(resolveDoc(filename), content, "utf8");
        return `wrote ${filename} (${content.length} bytes)`;
      }),
  );

  server.registerTool(
    "delete",
    {
      description: "Delete a document from the sample-docs folder.",
      inputSchema: { filename: z.string() },
    },
    ({ filename }) =>
      runTool("delete", { filename }, async () => {
        await unlink(resolveDoc(filename));
        return `deleted ${filename}`;
      }),
  );

  return server;
}

// See math-server/index.mjs's comment on this same line — identical
// DNS-rebinding-protection fix, just this container's own hostname.
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: ["docs-server", "docs-server:3002", "localhost"] });

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("close", () => {
    transport.close();
    server.close();
  });
});

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

const PORT = process.env.PORT ?? 3002;
app.listen(PORT, () => console.log(`docs-server listening on :${PORT}`));
