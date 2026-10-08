import { createServer } from "node:http";
import type { DiagnosticRecord } from "./preflight-diagnostics.js";
export function createLoopbackServer(
  port: number,
  getEndpoint: () => { fetch: (request: Request) => Promise<Response> } | undefined,
  diagnostic?: DiagnosticRecord,
) {
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // IncomingMessage 'close' also fires after a normally completed body.
    // The response socket owns cancellation while an endpoint is still waiting.
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      diagnostic?.("http_arrived");
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) {
        diagnostic?.("http_boundary_rejected");
        res.writeHead(403).end();
        return;
      }
      // This dedicated service has no OAuth metadata; Tunnel discovery expects absence as 404.
      if (
        req.method === "GET" &&
        [
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-protected-resource/mcp",
        ].includes(req.url ?? "")
      ) {
        diagnostic?.("oauth_metadata_absent");
        res.writeHead(404).end();
        return;
      }
      if (req.url !== "/mcp" || req.method !== "POST") {
        diagnostic?.("http_route_rejected");
        res.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 262144) {
          diagnostic?.("http_body_limit");
          res.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      if (!getEndpoint()) {
        diagnostic?.("endpoint_unavailable");
        res.writeHead(503).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(name, value);
      const response = await getEndpoint()!.fetch(
        new Request(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted || res.destroyed) return;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch {
      try {
        diagnostic?.("http_exception");
      } catch {
        /* fail closed if diagnostics storage fails */
      }
      if (!res.destroyed) {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  return server;
}
