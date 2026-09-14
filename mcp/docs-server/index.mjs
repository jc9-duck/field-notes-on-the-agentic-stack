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

function buildServer() {
  const server = new McpServer({ name: "docs-server", version: "1.0.0" });

  server.registerTool(
    "read",
    {
      description: "Read a document by filename from the sample-docs folder. Omit filename to list available documents.",
      inputSchema: { filename: z.string().optional() },
    },
    async ({ filename }) => {
      console.log(`[docs] read(${filename ?? "<list>"})`);
      if (!filename) {
        const files = await readdir(DOCS_DIR);
        return { content: [{ type: "text", text: files.join("\n") }] };
      }
      const text = await readFile(resolveDoc(filename), "utf8");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "write",
    {
      description: "Write (create or overwrite) a document in the sample-docs folder.",
      inputSchema: { filename: z.string(), content: z.string() },
    },
    async ({ filename, content }) => {
      console.log(`[docs] write(${filename}, ${content.length} bytes)`);
      await writeFile(resolveDoc(filename), content, "utf8");
      return { content: [{ type: "text", text: `wrote ${filename} (${content.length} bytes)` }] };
    },
  );

  server.registerTool(
    "delete",
    {
      description: "Delete a document from the sample-docs folder.",
      inputSchema: { filename: z.string() },
    },
    async ({ filename }) => {
      console.log(`[docs] delete(${filename})`);
      await unlink(resolveDoc(filename));
      return { content: [{ type: "text", text: `deleted ${filename}` }] };
    },
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
