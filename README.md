# Azure AI Proxy

A lightweight, streaming proxy that adapts OpenAI-compatible requests (e.g., from Zed or curl) to Azure OpenAI Chat Completions. It handles SSE streaming, transforms simple payloads (like `prompt`) into `messages`, and forwards requests to your Azure deployment with the correct `api-key`.

- Streams responses as Server-Sent Events (SSE)
- Works with OpenAI-compatible clients (e.g., Zed)
- Accepts either `prompt` or `messages` and always prepends a system message
- Uses `Authorization: Bearer <token>` from the client or falls back to `AZURE_API_KEY`
- Health check at `/health` and a basic status page at `/` or `/status`
- Run via Node.js or Docker (compose supported)
- Includes an alternative Go implementation (`azureAiProxy.go`)

---

## Quick Start (Node)

1) Prerequisites
- Node.js 20+ (Node 18+ with global `fetch` also works)
- npm

2) Install dependencies
    npm ci

3) Set environment variables (see Configuration below), then start:
    AZURE_API_ENDPOINT="https://<resource>.openai.azure.com/openai/deployments/<deployment>"
    AZURE_API_KEY="<your_azure_api_key>"
    AZURE_API_VERSION="2025-01-01-preview"
    PORT=8000
    npm start

The server will listen on `http://localhost:8000`.

Health check:
- GET http://localhost:8000/health → returns "OK"
- GET http://localhost:8000/status (or `/`) → basic HTML status page

---

## Configuration

Set the following environment variables (via shell or a `.env` file for Docker Compose):

- AZURE_API_ENDPOINT (required)  
  The base URL for your Azure OpenAI deployment. Do not include `/chat/completions` here; the proxy appends the path from the incoming request. Example:
    https://my-resource.openai.azure.com/openai/deployments/gpt-4o-mini

- AZURE_API_VERSION (optional; default: 2025-01-01-preview)  
  The Azure OpenAI API version.

- AZURE_API_KEY (optional)  
  Used if the client does not send `Authorization: Bearer <token>`. If the client includes this header, the proxy will use that value as the upstream `api-key`.

- PORT (optional; default: 8000)  
  Port for the proxy server.

Example `.env`:
    AZURE_API_ENDPOINT=https://my-resource.openai.azure.com/openai/deployments/gpt-4o-mini
    AZURE_API_VERSION=2025-01-01-preview
    AZURE_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
    PORT=8000

Security note: The proxy masks API keys when logging. Do not expose logs publicly.

---

## How It Works

- Incoming POST requests are forwarded to:
    ${AZURE_API_ENDPOINT}${req.url}?api-version=${AZURE_API_VERSION}

  For example, a client POST to:
    http://localhost:8000/chat/completions

  is proxied to:
    https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2025-01-01-preview

- Authorization header:
  - If the client sends `Authorization: Bearer <token>`, the proxy uses that as the upstream `api-key`.
  - Otherwise, the proxy uses `AZURE_API_KEY`.

- Payload transformation:
  - If the client sends `{ "prompt": "Hello" }`, the proxy converts it into a `messages` array and always prepends a system message:
    "You must always respond in markdown format."
  - If the client sends `messages`, the proxy prepends the same system message.
  - The proxy enforces streaming (`"stream": true`) to return SSE.

- Streaming:
  - The proxy streams Azure's `text/event-stream` back to the client.
  - Empty choice events are filtered out; `[DONE]` is forwarded.

---

## Usage Examples

Send a streaming chat completions request (curl):

    curl -N \
      -H "Content-Type: application/json" \
      -H "Accept: text/event-stream" \
      -H "Authorization: Bearer $AZURE_API_KEY" \
      -d '{
        "model": "gpt-4o-mini",
        "messages": [
          { "role": "user", "content": "Say hello in one sentence." }
        ],
        "stream": true
      }' \
      http://localhost:8000/chat/completions

Using a simple prompt (the proxy will transform it into messages):

    curl -N \
      -H "Content-Type: application/json" \
      -H "Accept: text/event-stream" \
      -H "Authorization: Bearer $AZURE_API_KEY" \
      -d '{
        "model": "gpt-4o-mini",
        "prompt": "Write a haiku about the ocean"
      }' \
      http://localhost:8000/chat/completions

Notes:
- `-N` keeps curl’s output unbuffered, which is important for SSE streaming.
- If you omit the `Authorization` header, set `AZURE_API_KEY` in the proxy environment.

---

## Zed Integration (OpenAI-compatible)

This proxy is intended to work with OpenAI-compatible clients like Zed. Configure Zed to use a custom base URL and your Azure deployment model name.

High-level steps:
1. Set the provider to “OpenAI Compatible.”
2. Base URL: http://localhost:8000
3. Model: your Azure deployment name (e.g., `gpt-4o-mini`).
4. Supply an API key:
   - Either put your Azure key directly in Zed (as the “token”), which the proxy will forward as `api-key`, or
   - Set `AZURE_API_KEY` on the proxy host and omit the token in Zed.

Consult Zed’s documentation for the exact configuration UI/JSON; point it to this proxy and use your deployment name as the model.

---

## Docker

Build the image:

    docker build -t azure-ai-proxy:local .

Run the container:

    docker run --rm -it \
      -e AZURE_API_ENDPOINT="https://<resource>.openai.azure.com/openai/deployments/<deployment>" \
      -e AZURE_API_KEY="<your_azure_api_key>" \
      -e AZURE_API_VERSION="2025-01-01-preview" \
      -e PORT=8000 \
      -p 8000:8000 \
      azure-ai-proxy:local

Health check:
- http://localhost:8000/health

Status page:
- http://localhost:8000/status

### Docker Compose

A `docker-compose.yml` is provided. Create a `.env` file (as shown above), then:

    docker compose up --build

To enable rebuild-on-change (Compose “develop” feature), use:

    docker compose up --build --watch

Compose will monitor `src`, `package.json`, `package-lock.json`, and `tsconfig.json` and rebuild the image on changes.

---

## Alternative: Go Implementation

A minimal Go version is included at `azureAiProxy.go`. It supports POST to `/` and streams SSE to the client.

Run with:
    AZURE_API_ENDPOINT="https://<resource>.openai.azure.com/openai/deployments/<deployment>" \
    AZURE_API_KEY="<your_azure_api_key>" \
    AZURE_API_VERSION="2025-01-01-preview" \
    PORT=8000 \
    go run azureAiProxy.go

Notes:
- The Go server expects POST to `/` and forwards to `.../chat/completions?api-version=...`.
- It does not include `/health` or `/status` endpoints.
- It performs the same prompt→messages transformation and SSE filtering.

---

## Troubleshooting

- 401 Unauthorized
  - Verify your Azure key is correct and active.
  - If passing `Authorization: Bearer <token>` from the client, ensure it’s the Azure key (not an OpenAI key).
  - If omitting the header, ensure `AZURE_API_KEY` is set in the proxy environment.

- 404 Not Found
  - Check `AZURE_API_ENDPOINT`. It must point to the deployment base:
    https://<resource>.openai.azure.com/openai/deployments/<deployment>
  - Ensure the client posts to `/chat/completions` on the proxy.

- 429 Too Many Requests / Quotas
  - Check Azure usage limits and rate limits on your deployment.

- Can’t connect to Azure
  - Load `/status` in the browser; the page shows a quick connectivity check result.
  - Ensure outbound network access to Azure is allowed.

- Empty or delayed streaming
  - Use `-N` with curl.
  - Check client disconnects; the proxy aborts upstream if the client closes.

---

## Development

- TypeScript sources in `src/` compile to `dist/`.
- Local dev:
    npm ci
    npm start

- With Docker Compose:
    docker compose up --build --watch

Do not run long-lived servers via tooling inside the container except as defined in `Dockerfile`/Compose; the proxy process must terminate on container stop.

---

## API Endpoints (Proxy)

- GET `/health` → "OK"
- GET `/status` (or `/`) → basic status page
- POST `/chat/completions` → streams Azure response; typical usage path

All other POST paths are forwarded as-is to `${AZURE_API_ENDPOINT}${req.url}` with the `api-version` query param appended.

---

## License

ISC (see `package.json`).

---

## Acknowledgements

Based on a gist by israrwz (payload transformation approach). This repo includes practical adjustments for Azure SSE streaming, filtering, and developer ergonomics.