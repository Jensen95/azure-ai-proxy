// Based on https://gist.github.com/israrwz/10c10b2adae480646eb62e5b926b9898
import http, { IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";

const AZURE_API_ENDPOINT = process.env.AZURE_API_ENDPOINT;
const AZURE_API_VERSION = process.env.AZURE_API_VERSION ?? "2025-01-01-preview";
const AZURE_API_KEY = process.env.AZURE_API_KEY;
const PROXY_PORT = parseInt(process.env.PORT ?? "8000", 10);

let lastRequestSuccessful = false;
let requestLog = [];

// Transform incoming Zed-like payload into an Azure Chat Completions payload
function transformRequest(zedPayload: any): any {
  const systemMessage = {
    role: "system",
    content: "You must always respond in markdown format.",
  };

  if (Object.prototype.hasOwnProperty.call(zedPayload, "prompt")) {
    const messages = [
      systemMessage,
      { role: "user", content: zedPayload.prompt },
    ];

    const azurePayload: any = {
      messages,
      temperature: zedPayload.temperature ?? 0.7,
      max_tokens: zedPayload.max_tokens ?? 200,
      stream: true,
    };

    // Remove prompt and merge any extra properties
    const { prompt, ...rest } = zedPayload;
    Object.assign(azurePayload, rest);
    return azurePayload;
  }

  const azurePayload: any = { ...zedPayload, stream: true };
  if (Array.isArray(azurePayload.messages)) {
    azurePayload.messages = [systemMessage, ...azurePayload.messages];
  } else {
    azurePayload.messages = [systemMessage];
  }
  return azurePayload;
}

// Handle streaming SSE from Azure and forward to client with filtering
async function streamAzureToClient(
  azureResp: Response,
  res: ServerResponse,
): Promise<void> {
  // Set SSE headers to client
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Prepare to read Web Stream from fetch response
  const reader = azureResp.body?.getReader();
  if (!reader) {
    // No body available; end gracefully
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    // Read and process stream chunk-by-chunk
    // We forward lines, filtering out `data: { choices: [] }` and passing through [DONE].
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.endsWith("\r")) line = line.slice(0, -1);

        // Forward blank lines to preserve SSE event boundaries
        if (line === "") {
          res.write("\n");
          continue;
        }

        if (line.startsWith("data:")) {
          const after = line.slice("data:".length);
          const trimmed = after.trim();

          // Forward DONE signal
          if (trimmed === "[DONE]") {
            res.write("data: [DONE]\n\n");
            continue;
          }

          // Filter out events with empty choices if the JSON parses
          const jsonStr = after.trimStart();
          if (jsonStr.length === 0) {
            // data: <empty> — ignore
            continue;
          }

          try {
            const payload = JSON.parse(jsonStr);
            if (
              Array.isArray(payload?.choices) &&
              payload.choices.length === 0
            ) {
              // Skip empty choices
              continue;
            }
            // Forward the original data line
            res.write(line + "\n");
          } catch {
            // Non-JSON or unexpected — forward as-is
            res.write(line + "\n");
          }
        } else {
          // Forward comment lines (e.g., starting with ":"), or any other lines
          res.write(line + "\n");
        }
      }
    }
  } catch (err: any) {
    // Client might have disconnected or other error occurred during streaming
    if (err?.name !== "AbortError") {
      console.error("Error during streaming to client:", err);
    }
  } finally {
    res.end();
  }
}

async function handlePost(req: IncomingMessage, res: ServerResponse) {
  // 1) Read JSON body from client (e.g., Zed)

  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("error", (err) => {
    console.error("Error reading request:", err);
  });

  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf-8");

    let zedPayload: {
      model: string;
      messages?: any[];
      stream?: boolean;
      temperature?: number;
      max_completions_tokens?: number;
      tools?: any[];
    };
    try {
      zedPayload = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid JSON from client");
      return;
    }

    // 2) Transform the request for Azure OpenAI
    const azurePayload = transformRequest(zedPayload);

    // 3) Forward the request to Azure OpenAI (streaming SSE)
    const azureUrl = `${AZURE_API_ENDPOINT}${req.url}?api-version=${AZURE_API_VERSION}`;

    const controller = new AbortController();
    // If the client disconnects, abort the upstream request
    res.on("close", () => controller.abort());
    const requestToken = req.headers["authorization"]?.toString().split(" ")[1];
    const accessToken = (
      requestToken?.length! > 0 ? requestToken! : (AZURE_API_KEY ?? "")
    ).trim();
    const requestSummary = {
      timestamp: new Date().toISOString(),
      url: req.url,
      userAgent: req.headers["user-agent"] || "unknown",
      authorization:
        accessToken.length > 0
          ? accessToken.length <= 8
            ? "Yes, but probably too short, length is smaller than 8"
            : `${accessToken.slice(0, 4)}...${accessToken.slice(-4)}`
          : "no",
      model: zedPayload.model,
      messageCount: Array.isArray(zedPayload.messages)
        ? zedPayload.messages.length
        : 0,
      tools: Array.isArray(zedPayload.tools)
        ? JSON.stringify(zedPayload.tools)
        : "none",
    };
    requestLog.push(requestSummary);
    console.info(requestSummary);
    try {
      const azureResp = await fetch(azureUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "api-key": accessToken ?? "",
          "user-agent": req.headers["user-agent"] || "azure-ai-proxy",
        },
        body: JSON.stringify(azurePayload),
        signal: controller.signal,
      });

      if (!azureResp.ok) {
        const errorText = await azureResp.text().catch(() => "");
        // If we haven't sent headers yet, send a 502
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(
            `Error communicating with Azure OpenAI: ${azureResp.status} ${azureResp.statusText}\n${errorText}`,
          );
        } else {
          // Headers already sent; just end
          res.end();
        }
        return;
      }

      // Stream SSE to client with filtering
      await streamAzureToClient(azureResp, res);
      lastRequestSuccessful = true;
    } catch (e: any) {
      const msg = `Error communicating with Azure OpenAI: ${e?.message ?? e}`;
      lastRequestSuccessful = false;
      console.error(msg);

      if (!res.headersSent) {
        try {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(msg);
        } catch (sendErr) {
          console.error("Could not send 502 error response:", sendErr);
        }
      } else {
        // If already streaming, try to end gracefully
        try {
          res.end();
        } catch (endErr) {
          console.error("Could not end response after error:", endErr);
        }
      }
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  } else if (
    req.method === "GET" &&
    (req.url === "/" || req.url === "/status")
  ) {
    (async () => {
      const hasKey = !!(
        process.env.AZURE_API_KEY && process.env.AZURE_API_KEY.length > 0
      );
      const azureUrl = `${AZURE_API_ENDPOINT}/chat/completions?api-version=${AZURE_API_VERSION}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      let statusText = "";
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(hasKey ? { "api-key": process.env.AZURE_API_KEY! } : {}),
        };
        const resp = await fetch(azureUrl, {
          method: "POST",
          headers,
          body: "{}",
          signal: controller.signal,
        });
        statusText = `${resp.status} ${resp.statusText}`;
      } catch (e: any) {
        statusText = `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
      } finally {
        clearTimeout(timer);
      }

      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>azure-ai-proxy status</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:2rem;line-height:1.4} code{background:#f4f4f4;padding:.1rem .3rem;border-radius:.25rem}</style>
</head>
<body>
  <h1>Azure AI Proxy — Status</h1>
  <ul>
    <li>Azure endpoint: <code>${AZURE_API_ENDPOINT}</code></li>
    <li>API key present: <strong>${hasKey ? "yes" : "no"}</strong></li>
    <li>Connectivity check (POST malformed request): <strong>${statusText || "no response"}</strong></li>
    <li>Last request successful: <strong>${lastRequestSuccessful ? "yes" : "no"}</strong></li>
  </ul>
  <p>Health endpoint: <a href="/health">/health</a></p>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    })();
  } else if (req.method === "POST") {
    handlePost(req, res);
  } else {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
  }
});

server.listen(PROXY_PORT, () => {
  const addr = server.address() as AddressInfo | null;
  const port = addr?.port ?? PROXY_PORT;
  console.log(`Starting Azure OpenAI proxy server on port ${port}`);
});
