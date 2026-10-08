import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
export class EventError extends Error {
  constructor(
    public readonly code: string,
    public readonly reason?: string,
  ) {
    super(code);
  }
}
// Read only a fixed code, never message/stack/cause/hostname/certificate details.
export function transportReason(error: unknown): string {
  let code: unknown;
  try {
    code = (error as { code?: unknown })?.code;
  } catch {
    return "unknown";
  }
  if (code === "ENOTFOUND") return "dns_not_found";
  if (code === "EAI_AGAIN") return "dns_temporary";
  if (
    typeof code === "string" &&
    [
      "ERR_INVALID_ARG_TYPE",
      "ERR_INVALID_ARG_VALUE",
      "ERR_HTTP_INVALID_HEADER_VALUE",
      "ERR_INVALID_CHAR",
    ].includes(code)
  )
    return "request_invalid";
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "tls_hostname";
  if (code === "CERT_HAS_EXPIRED" || code === "CERT_NOT_YET_VALID") return "tls_validity";
  if (
    typeof code === "string" &&
    [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_UNTRUSTED",
      "CERT_REVOKED",
    ].includes(code)
  )
    return "tls_trust";
  if (typeof code === "string" && (code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_")))
    return "tls_protocol";
  if (code === "ETIMEDOUT" || code === "ERR_SOCKET_CONNECTION_TIMEOUT") return "timeout";
  if (code === "ECONNREFUSED") return "socket_refused";
  if (code === "EACCES" || code === "EPERM") return "socket_permission";
  if (code === "ECONNRESET" || code === "EPIPE") return "socket_reset";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") return "socket_unreachable";
  if (typeof code === "string" && code.startsWith("HPE_")) return "http_parse";
  return "unknown";
}
export function signingKey(secret: string): Buffer {
  if (secret.length > 94 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new EventError("invalid_secret");
  const b64 = secret.slice(6),
    key = Buffer.from(b64, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== b64)
    throw new EventError("invalid_secret");
  return key;
}
export function headersFor(
  id: string,
  subscriptionId: string,
  body: string,
  secrets: string[],
  now: number,
) {
  if (Buffer.byteLength(body) > 262144) throw new EventError("payload_limit");
  const timestamp = String(Math.floor(now / 1000));
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": secrets
      .map(
        (secret) =>
          `v1,${createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
      )
      .join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  };
}
export function equalChallenge(actual: unknown, expected: string) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export type Reply = { status: number; body: string };
export type Post = (
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) => Promise<Reply>;
export type Pinned = { hostname: string; address: string; path: string };
export function callbackUrl(raw: string, allowedHosts: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EventError("callback_rejected");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== "443") ||
    !allowedHosts.includes(u.hostname) ||
    u.hostname.startsWith("[") ||
    isIP(u.hostname)
  )
    throw new EventError("callback_rejected");
  return u;
}
/** Deliberately IPv4-only for now. Fail closed for IPv6 rather than guess its special ranges. */
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export async function pinCallback(
  raw: string,
  allowedHosts: readonly string[],
  resolve: (hostname: string) => Promise<string[]>,
): Promise<Pinned> {
  const u = callbackUrl(raw, allowedHosts);
  let addresses: string[];
  try {
    addresses = await resolve(u.hostname);
  } catch (error) {
    const reason = transportReason(error);
    throw new EventError("dns_failed", reason === "unknown" ? "dns_other" : reason);
  }
  if (!addresses.length) throw new EventError("callback_rejected", "dns_empty");
  if (addresses.length > 32 || !addresses.every(publicIPv4))
    throw new EventError("callback_rejected", "address_rejected");
  return { hostname: u.hostname, address: addresses[0]!, path: u.pathname + u.search };
}
export type PinnedSend = (
  target: Pinned,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) => Promise<Reply>;
/** No redirect, proxy, pooled socket or second DNS resolution. TLS still verifies original hostname. */
export function createNodePinnedSend(httpRequest: typeof request = request): PinnedSend {
  return (target, headers, body, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new EventError("delivery_cancelled"));
        return;
      }
      const timeout = AbortSignal.timeout(10000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const fail = (error: unknown) =>
        reject(
          new EventError(
            "delivery_failed",
            signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : transportReason(error),
          ),
        );
      try {
        const req = httpRequest(
          {
            protocol: "https:",
            hostname: target.hostname,
            servername: target.hostname,
            port: 443,
            path: target.path,
            method: "POST",
            agent: false,
            rejectUnauthorized: true,
            family: 4,
            lookup: (_host, _options, callback) => callback(null, target.address, 4),
            signal: combined,
            headers: {
              ...headers,
              Host: target.hostname,
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 4096) {
                reject(new EventError("response_limit", "response_limit"));
                response.destroy();
              } else chunks.push(chunk);
            });
            response.on("error", fail);
            response.on("aborted", () =>
              reject(new EventError("delivery_failed", "response_truncated")),
            );
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", fail);
        req.end(body);
      } catch (error) {
        fail(error);
      }
    });
}
export const nodePinnedSend = createNodePinnedSend();
/** Merely constructing this sender opens no connection; no current CLI/MCP entry calls it. */
export function createPost(
  allowedHosts: readonly string[],
  // Match the IPv4-only connector. Querying AAAA too made a valid public dual-stack
  // host fail the IPv4 safety check before any HTTPS request could be attempted.
  resolve = async (host: string) =>
    (await lookup(host, { all: true, family: 4 })).map((a) => a.address),
  send: PinnedSend = nodePinnedSend,
): Post {
  return async (url, headers, body, signal) => {
    if (signal?.aborted) throw new EventError("delivery_cancelled");
    if (Buffer.byteLength(body) > 262144) throw new EventError("payload_limit");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 10000);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          signal?.aborted
            ? new EventError("delivery_cancelled", "cancelled")
            : new EventError("delivery_failed", "timeout"),
        );
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
    });
    const work = async () => {
      const pinned = await pinCallback(url, allowedHosts, resolve);
      if (combined.aborted) throw new EventError("delivery_cancelled");
      const reply = await send(pinned, headers, body, combined);
      if (combined.aborted) throw new EventError("delivery_cancelled");
      if (reply.status >= 300 && reply.status < 400) throw new EventError("redirect_rejected");
      return reply;
    };
    try {
      return await Promise.race([cancelled, work()]);
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
    }
  };
}
