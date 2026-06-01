#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";

const API_KEY = process.env.PIXEL_SURGEON_API_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!API_KEY) {
  console.error("PIXEL_SURGEON_API_KEY env var is required");
  process.exit(1);
}

function log(msg: string) {
  console.error(`[pixel-surgeon-server ${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const clientTransport = new StdioClientTransport({
    command: "npx",
    args: ["pixel-surgeon-mcp"],
    env: {
      ...process.env as Record<string, string>,
    },
  });

  const client = new Client({ name: "pixel-surgeon-server", version: "1.0.0" });
  await client.connect(clientTransport);
  log("Connected to pixel-surgeon-mcp via stdio");

  const tools = await client.listTools();
  log(`Discovered ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);

  const server = new Server(
    { name: "pixel-surgeon-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return client.listTools();
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return client.callTool(request.params);
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  log("MCP proxy server ready");

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Request error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    log(`Listening on 0.0.0.0:${PORT}`);
  });

  process.on("SIGTERM", () => {
    log("SIGTERM received, shutting down");
    httpServer.close();
    client.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
