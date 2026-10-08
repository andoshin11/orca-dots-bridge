// Independent test receiver based on the Standard Webhooks verification contract.
// Deliberately does not import the producer's signing/parsing helpers or use createHmac.
import { webcrypto } from "node:crypto";
export async function verifyStandardWebhook(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  keyBytes: Uint8Array,
  now = Date.now(),
): Promise<unknown> {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const id = h["webhook-id"],
    time = h["webhook-timestamp"],
    signature = h["webhook-signature"];
  if (
    typeof id !== "string" ||
    !id ||
    typeof time !== "string" ||
    !/^\d+$/.test(time) ||
    typeof signature !== "string"
  )
    throw new Error("receiver_rejected");
  if (Math.abs(Math.floor(now / 1000) - Number(time)) > 300) throw new Error("receiver_rejected");
  const data = Buffer.concat([Buffer.from(id + "." + time + "."), body]);
  const key = await webcrypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const entry of signature.split(" ")) {
    const [version, b64] = entry.split(",");
    if (version !== "v1" || !b64) continue;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.toString("base64") !== b64) continue;
    if (await webcrypto.subtle.verify("HMAC", key, bytes, data))
      return JSON.parse(body.toString("utf8")) as unknown;
  }
  throw new Error("receiver_rejected");
}
