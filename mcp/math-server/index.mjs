#!/usr/bin/env node
// Minimal MCP server, no interesting policy attached to it in config.yaml —
// its whole job is to prove agentgateway's multiplexing works across more
// than one backend, alongside docs-server (which *does* have policy).
//
// Streamable HTTP (stateless), not stdio: agentgateway's own container is a
// distroless image with no node/npm inside it, so it can't spawn this as a
// stdio subprocess the way `mcp.targets[].mcp.stdio` examples assume for
// npx-installable servers. Each server here is its own container instead,
// reached over HTTP via Docker Compose's internal network
// (`mcp.targets[].mcp.host: math-server:3001` in config.yaml.template).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

function buildServer() {
  const server = new McpServer({ name: "math-server", version: "1.0.0" });

  const binaryOp = (name, fn) =>
    server.registerTool(
      name,
      { description: `${name} two numbers`, inputSchema: { a: z.number(), b: z.number() } },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(fn(a, b)) }] }),
    );

  binaryOp("add", (a, b) => a + b);
  binaryOp("subtract", (a, b) => a - b);
  binaryOp("multiply", (a, b) => a * b);
  server.registerTool(
    "divide",
    { description: "divide two numbers", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => {
      if (b === 0) return { content: [{ type: "text", text: "error: division by zero" }], isError: true };
      return { content: [{ type: "text", text: String(a / b) }] };
    },
  );

  return server;
}

// createMcpExpressApp() defaults to host: "127.0.0.1", which auto-enables
// DNS-rebinding protection that only trusts a Host header of
// 127.0.0.1/localhost/::1 — agentgateway proxies to this container with
// Host: math-server (its Compose service name), which that default rejects
// with a bare 403 (confirmed directly: agentgateway's own debug log showed
// a clean upstream connection immediately followed by http.status=403 from
// this server, not from agentgateway itself). allowedHosts opts this
// container's own Compose-network hostname back in.
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: ["math-server", "math-server:3001", "localhost"] });

// Stateless mode (sessionIdGenerator: undefined): a fresh McpServer +
// transport per request. This is a stdlib-arithmetic demo server with no
// state to keep between calls, so stateless keeps it simple — no session
// bookkeeping to reason about when reading this file.
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

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => console.log(`math-server listening on :${PORT}`));
