import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
export class EventError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
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
export type Post = (url: string, headers: Record<string, string>, body: string) => Promise<Reply>;
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
  } catch {
    throw new EventError("dns_failed");
  }
  if (!addresses.length || addresses.length > 32 || !addresses.every(publicIPv4))
    throw new EventError("callback_rejected");
  return { hostname: u.hostname, address: addresses[0]!, path: u.pathname + u.search };
}
export type PinnedSend = (
  target: Pinned,
  headers: Record<string, string>,
  body: string,
) => Promise<Reply>;
/** No redirect, proxy, pooled socket or second DNS resolution. TLS still verifies original hostname. */
export function createNodePinnedSend(httpRequest: typeof request = request): PinnedSend {
  return (target, headers, body) =>
    new Promise((resolve, reject) => {
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
          signal: AbortSignal.timeout(10000),
          headers: { ...headers, Host: target.hostname, "Content-Length": Buffer.byteLength(body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4096) {
              response.destroy();
              reject(new EventError("response_limit"));
            } else chunks.push(chunk);
          });
          response.on("error", () => reject(new EventError("delivery_failed")));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", () => reject(new EventError("delivery_failed")));
      req.end(body);
    });
}
export const nodePinnedSend = createNodePinnedSend();
/** Merely constructing this sender opens no connection; no current CLI/MCP entry calls it. */
export function createPost(
  allowedHosts: readonly string[],
  resolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address),
  send: PinnedSend = nodePinnedSend,
): Post {
  return async (url, headers, body) => {
    if (Buffer.byteLength(body) > 262144) throw new EventError("payload_limit");
    const pinned = await pinCallback(url, allowedHosts, resolve);
    const reply = await send(pinned, headers, body);
    if (reply.status >= 300 && reply.status < 400) throw new EventError("redirect_rejected");
    return reply;
  };
}
