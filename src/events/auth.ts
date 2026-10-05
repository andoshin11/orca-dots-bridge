import { digest, type Target } from "./model.js";
import { EventError } from "./webhook.js";
/** Adapter contract: verify cryptographic signature (or introspect), revocation and token type.
 * No insecure JWT decode-only fallback. No current CLI/MCP entry constructs this adapter. */
export type VerifyAccessToken = (token: string) => Promise<{
  issuer: string;
  subject: string;
  audience: string[];
  expiresAt: number;
  scopes: string[];
} | null>;
export function createOwnerResolver(
  issuer: string,
  audience: string,
  verify: VerifyAccessToken,
  now = Date.now,
) {
  return async (authorization: string | undefined): Promise<string> => {
    if (
      !authorization ||
      authorization.length > 8192 ||
      !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization)
    )
      throw new EventError("unauthorized");
    let claims;
    try {
      claims = await verify(authorization.slice(7));
    } catch {
      throw new EventError("unauthorized");
    }
    if (
      !claims ||
      claims.issuer !== issuer ||
      !claims.subject ||
      claims.subject.length > 256 ||
      !claims.audience.includes(audience) ||
      !Number.isFinite(claims.expiresAt) ||
      claims.expiresAt <= now() ||
      !claims.scopes.includes("orca:events")
    )
      throw new EventError("unauthorized");
    return `owner_${digest([claims.issuer, claims.subject])}`;
  };
}
/** Per-target permission lives server-side. Never derive it from clientInfo or subscription arguments. */
export type TargetAuthorization = (owner: string, target: Target) => Promise<boolean>;
