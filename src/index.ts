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
import { randomUUID } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";

const API_KEY = process.env.PIXEL_SURGEON_API_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IMAGE_DIR = "/tmp/pixel-surgeon-images";

if (!API_KEY) {
  console.error("PIXEL_SURGEON_API_KEY env var is required");
  process.exit(1);
}

function log(msg: string) {
  console.error(`[pixel-surgeon-server ${new Date().toISOString()}] ${msg}`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

interface ImageRecord {
  id: string;
  filename: string;
  prompt: string;
  model: string;
  timestamp: number;
}

const imageIndex: ImageRecord[] = [];

async function saveImage(base64: string, mime: string, prompt: string, model: string): Promise<ImageRecord> {
  await mkdir(IMAGE_DIR, { recursive: true });
  const id = randomUUID().slice(0, 12);
  const ext = mime.includes("jpeg") ? ".jpg" : ".png";
  const filename = `${id}${ext}`;
  await writeFile(join(IMAGE_DIR, filename), Buffer.from(base64, "base64"));
  const record: ImageRecord = { id, filename, prompt, model, timestamp: Date.now() };
  imageIndex.push(record);
  log(`Saved image ${filename} (${prompt.slice(0, 60)}...)`);
  return record;
}

function extractImagesFromResult(result: { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> }): Array<{ base64: string; mime: string }> {
  const images: Array<{ base64: string; mime: string }> = [];
  for (const item of result.content) {
    if (item.type === "image" && item.data && item.mimeType) {
      images.push({ base64: item.data, mime: item.mimeType });
    }
  }
  return images;
}

function extractTextFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text!)
    .join("\n");
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

  // --- MCP transport (for native MCP clients) ---

  const mcpServer = new Server(
    { name: "pixel-surgeon-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return client.listTools();
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    return client.callTool(request.params);
  });

  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(mcpTransport);
  log("MCP proxy server ready");

  // --- REST API handlers ---

  async function handleApiGenerate(req: IncomingMessage, res: ServerResponse) {
    try {
      const body = JSON.parse(await readBody(req));
      const { prompt, aspect_ratio, image_size, model, style } = body;
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "prompt is required" }));
        return;
      }

      log(`API generate: "${prompt.slice(0, 80)}"`);
      const result = await client.callTool({
        name: "generate_image",
        arguments: {
          prompt,
          ...(aspect_ratio && { aspect_ratio }),
          ...(image_size && { image_size }),
          ...(model && { model }),
          ...(style && { style }),
        },
      }) as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };

      const images = extractImagesFromResult(result);
      const text = extractTextFromResult(result);

      if (images.length === 0) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image generated", details: text }));
        return;
      }

      const record = await saveImage(images[0].base64, images[0].mime, prompt, model || "default");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: `${BASE_URL}/images/${record.filename}`,
        id: record.id,
        filename: record.filename,
        prompt,
        model: record.model,
        details: text,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`API generate error: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  }

  async function handleApiEdit(req: IncomingMessage, res: ServerResponse) {
    try {
      const body = JSON.parse(await readBody(req));
      const { filename, prompt, aspect_ratio, image_size, model } = body;
      if (!filename || !prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "filename and prompt are required" }));
        return;
      }

      log(`API edit: "${prompt.slice(0, 80)}" on ${filename}`);
      const result = await client.callTool({
        name: "edit_image",
        arguments: {
          filename,
          prompt,
          ...(aspect_ratio && { aspect_ratio }),
          ...(image_size && { image_size }),
          ...(model && { model }),
        },
      }) as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };

      const images = extractImagesFromResult(result);
      const text = extractTextFromResult(result);

      if (images.length === 0) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image generated", details: text }));
        return;
      }

      const record = await saveImage(images[0].base64, images[0].mime, prompt, model || "default");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: `${BASE_URL}/images/${record.filename}`,
        id: record.id,
        filename: record.filename,
        prompt,
        model: record.model,
        details: text,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`API edit error: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  }

  async function handleApiImages(res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      images: imageIndex.map((r) => ({
        ...r,
        url: `${BASE_URL}/images/${r.filename}`,
      })),
    }));
  }

  async function handleServeImage(filename: string, res: ServerResponse) {
    try {
      const buf = await readFile(join(IMAGE_DIR, filename));
      const mime = filename.endsWith(".jpg") ? "image/jpeg" : "image/png";
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Image not found" }));
    }
  }

  // --- HTTP server ---

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Serve images without auth (they have unguessable IDs)
    if (url.pathname.startsWith("/images/") && req.method === "GET") {
      const filename = decodeURIComponent(url.pathname.slice(8));
      if (filename.includes("..") || filename.includes("/")) {
        res.writeHead(400);
        res.end();
        return;
      }
      await handleServeImage(filename, res);
      return;
    }

    if (!checkAuth(req, res)) return;

    // REST API
    if (url.pathname === "/api/generate" && req.method === "POST") {
      await handleApiGenerate(req, res);
      return;
    }

    if (url.pathname === "/api/edit" && req.method === "POST") {
      await handleApiEdit(req, res);
      return;
    }

    if (url.pathname === "/api/images" && req.method === "GET") {
      await handleApiImages(res);
      return;
    }

    // MCP transport
    if (url.pathname === "/mcp") {
      try {
        await mcpTransport.handleRequest(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`MCP request error: ${msg}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    log(`Listening on 0.0.0.0:${PORT}`);
    log(`REST API: ${BASE_URL}/api/generate, ${BASE_URL}/api/edit, ${BASE_URL}/api/images`);
    log(`MCP: ${BASE_URL}/mcp`);
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
