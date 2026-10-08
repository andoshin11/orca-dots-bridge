import { createHash, timingSafeEqual } from "node:crypto";
import { EventError } from "./webhook.js";
/** Authenticates a dedicated service, never an inferred human user. */
export function createServiceKeyResolver(options: {
  keyId: string;
  secret: Buffer;
  expiresAt: number;
  now?: () => number;
}) {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(options.keyId) ||
    options.secret.length !== 32 ||
    !Number.isFinite(options.expiresAt)
  )
    throw new Error("invalid_service_key_configuration");
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const expected = hash(`Bearer ${options.secret.toString("base64url")}`);
  let revoked = false;
  return {
    owner: `service:${options.keyId}`,
    revoke: () => {
      revoked = true;
      expected.fill(0);
    },
    resolve: async (authorization: string | undefined) => {
      if (
        revoked ||
        (options.now ?? Date.now)() >= options.expiresAt ||
        !authorization ||
        authorization.length > 128 ||
        !timingSafeEqual(expected, hash(authorization))
      )
        throw new EventError("unauthorized");
      return `service:${options.keyId}`;
    },
  };
}
