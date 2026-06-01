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

function checkAuth(req: IncomingMessage, res: ServerResponse, url?: URL): boolean {
  const keyParam = url?.searchParams.get("key");
  if (keyParam === API_KEY) return true;
  if (req.headers.authorization === `Bearer ${API_KEY}`) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function imagePage(record: ImageRecord, details: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pixel-surgeon — ${esc(record.prompt.slice(0, 60))}</title>
<style>
  body { margin: 0; background: #1a1a1a; color: #ccc; font-family: system-ui; display: flex; flex-direction: column; align-items: center; padding: 16px; }
  img { max-width: 100%; border-radius: 6px; margin: 16px 0; }
  .prompt { background: #252525; color: #bbb; border: 1px solid #444; padding: 12px; border-radius: 6px; max-width: 600px; width: 100%; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .meta { color: #666; font-size: 12px; margin-top: 8px; }
  h1 { font-size: 16px; color: #8bc4ff; margin: 8px 0; }
</style></head><body>
<h1>pixel-surgeon</h1>
<div class="prompt">${esc(record.prompt)}</div>
<img src="/images/${esc(record.filename)}" alt="${esc(record.prompt.slice(0, 100))}">
<div class="meta">${esc(record.model)} · ${esc(record.filename)}${details ? " · " + esc(details.slice(0, 200)) : ""}</div>
</body></html>`;
}

function errorPage(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pixel-surgeon — error</title>
<style>body { margin: 40px; background: #1a1a1a; color: #ccc; font-family: system-ui; } h1 { color: #f44336; font-size: 18px; } p { color: #999; }</style>
</head><body><h1>${esc(title)}</h1><p>${esc(detail)}</p></body></html>`;
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

    // GET endpoints — auth via ?key= query param
    if (url.pathname === "/api/generate" && req.method === "GET") {
      if (!checkAuth(req, res, url)) return;
      const prompt = url.searchParams.get("prompt");
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorPage("Missing prompt", "Add ?prompt=your+description to the URL."));
        return;
      }
      try {
        log(`GET generate: "${prompt.slice(0, 80)}"`);
        const aspect_ratio = url.searchParams.get("aspect_ratio") || undefined;
        const image_size = url.searchParams.get("image_size") || undefined;
        const model = url.searchParams.get("model") || undefined;
        const style = url.searchParams.get("style") || undefined;
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
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(errorPage("No image generated", text));
          return;
        }
        const record = await saveImage(images[0].base64, images[0].mime, prompt, model || "default");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(imagePage(record, text));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`GET generate error: ${msg}`);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(errorPage("Generation failed", msg));
      }
      return;
    }

    if (url.pathname === "/api/edit" && req.method === "GET") {
      if (!checkAuth(req, res, url)) return;
      const filename = url.searchParams.get("filename");
      const prompt = url.searchParams.get("prompt");
      if (!filename || !prompt) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorPage("Missing params", "Both filename and prompt are required."));
        return;
      }
      try {
        log(`GET edit: "${prompt.slice(0, 80)}" on ${filename}`);
        const aspect_ratio = url.searchParams.get("aspect_ratio") || undefined;
        const image_size = url.searchParams.get("image_size") || undefined;
        const model = url.searchParams.get("model") || undefined;
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
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(errorPage("No image generated", text));
          return;
        }
        const record = await saveImage(images[0].base64, images[0].mime, prompt, model || "default");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(imagePage(record, text));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`GET edit error: ${msg}`);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(errorPage("Edit failed", msg));
      }
      return;
    }

    if (url.pathname === "/api/images" && req.method === "GET") {
      if (!checkAuth(req, res, url)) return;
      await handleApiImages(res);
      return;
    }

    // POST endpoints — auth via Authorization header
    if (!checkAuth(req, res, url)) return;

    if (url.pathname === "/api/generate" && req.method === "POST") {
      await handleApiGenerate(req, res);
      return;
    }

    if (url.pathname === "/api/edit" && req.method === "POST") {
      await handleApiEdit(req, res);
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
