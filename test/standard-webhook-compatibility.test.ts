import { expect, it } from "vitest";
import { headersFor } from "../src/events/webhook.js";
import { verifyStandardWebhook } from "./fixtures/standard-webhook-receiver.js";
const key = Buffer.alloc(32, 7),
  now = 1791417600000;
const payload = Buffer.from(
  JSON.stringify({ type: "verification", challenge: "synthetic_日本語" }),
);
function headers() {
  return headersFor(
    "verify_synthetic",
    "sub_synthetic",
    payload.toString(),
    ["whsec_" + key.toString("base64")],
    now,
  );
}
it("interoperates with independent WebCrypto verifier using exact UTF-8 body bytes", async () => {
  await expect(verifyStandardWebhook(payload, headers(), key, now)).resolves.toEqual(
    JSON.parse(payload.toString()),
  );
});
it.each(["body", "id", "timestamp", "secret", "version", "signature", "old", "future"])(
  "independent receiver rejects tampered %s",
  async (mode) => {
    const h: Record<string, string> = { ...headers() };
    let b = payload,
      k = key,
      t = now;
    if (mode === "body") b = Buffer.concat([payload, Buffer.from(" ")]);
    if (mode === "id") h["webhook-id"] = "other";
    if (mode === "timestamp") h["webhook-timestamp"] = String(now / 1000 + 1);
    if (mode === "secret") k = Buffer.alloc(32, 8);
    if (mode === "version") h["webhook-signature"] = h["webhook-signature"]!.replace("v1,", "v2,");
    if (mode === "signature") h["webhook-signature"] = "v1," + Buffer.alloc(32).toString("base64");
    if (mode === "old") t += 301000;
    if (mode === "future") t -= 301000;
    await expect(verifyStandardWebhook(b, h, k, t)).rejects.toThrow("receiver_rejected");
  },
);
it("accepts case-insensitive headers and one valid rotation signature", async () => {
  const h = headersFor(
    "verify_synthetic",
    "sub_synthetic",
    payload.toString(),
    ["whsec_" + Buffer.alloc(32, 8).toString("base64"), "whsec_" + key.toString("base64")],
    now,
  );
  await expect(
    verifyStandardWebhook(
      payload,
      Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toUpperCase(), v])),
      key,
      now,
    ),
  ).resolves.toEqual(JSON.parse(payload.toString()));
});
