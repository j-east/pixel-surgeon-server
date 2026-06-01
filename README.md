# pixel-surgeon-server

HTTP wrapper for [pixel-surgeon-mcp](https://github.com/j-east/pixel-surgeon-mcp) — exposes all pixel-surgeon MCP tools over Streamable HTTP transport with bearer token auth.

Built for remote access (e.g., Claude on mobile) via self-hosted deployment.

## How it works

Spawns `pixel-surgeon-mcp` as a stdio child process, connects as an MCP client, then proxies all tool calls through an HTTP server using the MCP [Streamable HTTP transport](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PIXEL_SURGEON_API_KEY` | Yes | Bearer token for authenticating requests |
| `GOOGLE_API_KEY` | * | Enables Gemini image generation |
| `OPENAI_API_KEY` | * | Enables OpenAI image generation |
| `XAI_API_KEY` | * | Enables xAI/Grok image generation |
| `PORT` | No | Server port (default: 3000) |

\* At least one image provider API key is required.

## Endpoints

- `POST /mcp` — MCP Streamable HTTP (requires `Authorization: Bearer <key>`)
- `GET /mcp` — MCP SSE stream (requires auth)
- `DELETE /mcp` — MCP session termination (requires auth)
- `GET /health` — Health check (no auth required)

## Local development

```bash
npm install
npm run dev
```

## Docker

```bash
docker build -t pixel-surgeon-server .
docker run -p 3000:3000 \
  -e PIXEL_SURGEON_API_KEY=your-secret \
  -e GOOGLE_API_KEY=your-key \
  pixel-surgeon-server
```

## Connecting from Claude

Add as a remote MCP server with the URL `https://your-host/mcp` and your API key as the bearer token.
