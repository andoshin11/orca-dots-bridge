import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { relayMessageSchema, type RelayStatus } from "./pane-contract.js";

const TOLERANCE_SECONDS = 300;
const MAX_BODY_BYTES = 65536;
const REPLAY_LIMIT = 4096;

/**
 * Verifies Standard Webhooks messages from orca-agent-status-relay. The key is
 * the 32-byte secret behind the plugin's `whsec_` value. Replay protection
 * remembers each `webhook-id` for the timestamp tolerance window.
 */
export function createRelayIngress(options: {
  key: Buffer;
  onStatus: (status: RelayStatus) => void;
  now?: () => number;
  diagnostic?: DiagnosticRecord;
}) {
  if (options.key.length !== 32) throw new Error("invalid_relay_key");
  const now = options.now ?? Date.now;
  const seen = new Map<string, number>();
  const purge = () => {
    for (const [key, expiry] of seen) if (expiry <= now()) seen.delete(key);
  };
  const remember = (id: string, until: number) => {
    if (seen.size >= REPLAY_LIMIT) return false;
    seen.set(id, until);
    return true;
  };
  return {
    /** Returns the HTTP status to answer with. */
    accept(headers: IncomingHttpHeaders, body: string): number {
      const id = headers["webhook-id"];
      const timestamp = headers["webhook-timestamp"];
      const signatures = headers["webhook-signature"];
      if (
        typeof id !== "string" ||
        typeof timestamp !== "string" ||
        typeof signatures !== "string" ||
        id.length === 0 ||
        id.length > 256 ||
        !/^\d{1,12}$/.test(timestamp)
      ) {
        options.diagnostic?.("relay_signature_rejected");
        return 401;
      }
      const seconds = Number(timestamp);
      if (Math.abs(now() / 1000 - seconds) > TOLERANCE_SECONDS) {
        options.diagnostic?.("relay_signature_rejected");
        return 401;
      }
      const expected = createHmac("sha256", options.key)
        .update(`${id}.${timestamp}.${body}`)
        .digest();
      const valid = signatures.split(" ").some((entry) => {
        const [version, value] = entry.split(",");
        if (version !== "v1" || !value) return false;
        const actual = Buffer.from(value, "base64");
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      });
      if (!valid) {
        options.diagnostic?.("relay_signature_rejected");
        return 401;
      }
      // Counted only once signed, so unauthenticated local traffic cannot drive diagnostics writes.
      options.diagnostic?.("relay_arrived");
      // Forget ids past the tolerance window first: such a message fails the timestamp check anyway.
      purge();
      if (seen.has(id)) {
        options.diagnostic?.("relay_replay_rejected");
        return 409;
      }
      if (!remember(id, (seconds + TOLERANCE_SECONDS) * 1000)) {
        options.diagnostic?.("relay_replay_rejected");
        return 429;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        options.diagnostic?.("relay_schema_rejected");
        return 400;
      }
      const message = relayMessageSchema.safeParse(raw);
      if (!message.success) {
        options.diagnostic?.("relay_schema_rejected");
        return 400;
      }
      if (message.data.type === "relay.test") {
        options.diagnostic?.("relay_test_received");
        return 204;
      }
      options.diagnostic?.("relay_status_received");
      options.onStatus(message.data);
      return 204;
    },
  };
}

/**
 * Loopback-only listener for relay messages, separate from the MCP listener so
 * that whatever a Tunnel forwards never reaches this route.
 */
export function createRelayServer(
  port: number,
  ingress: { accept: (headers: IncomingHttpHeaders, body: string) => number },
  diagnostic?: DiagnosticRecord,
) {
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) {
        diagnostic?.("http_boundary_rejected");
        res.writeHead(403).end();
        return;
      }
      if (req.url !== "/relay" || req.method !== "POST") {
        diagnostic?.("http_route_rejected");
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) {
          diagnostic?.("http_body_limit");
          res.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      res.writeHead(ingress.accept(req.headers, Buffer.concat(chunks).toString("utf8"))).end();
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
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  return server;
}
