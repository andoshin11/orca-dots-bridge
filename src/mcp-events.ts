import { EventEngine, type EngineOptions } from "./events/engine.js";
import { createOwnerResolver, type VerifyAccessToken } from "./events/auth.js";
import { createRuntimeEventTransport } from "./events/runtime-transport.js";
import { SessionEventsRpc } from "./events/session-rpc.js";
import { createSessionMcpHttpEntry } from "./events/http-entry.js";
/** Explicit embedding entry. No ambient credential reads, listener, or background start on import. */
export async function createConfiguredNotificationEndpoint(options: {
  engine: EngineOptions;
  runtime: { endpoint: string; authToken: string; runtimeId: string };
  oauth: { issuer: string; audience: string; verify: VerifyAccessToken };
}) {
  const engine = await EventEngine.open(options.engine);
  const rpc = new SessionEventsRpc(engine, createRuntimeEventTransport(options.runtime));
  return {
    fetch: createSessionMcpHttpEntry(
      rpc,
      createOwnerResolver(options.oauth.issuer, options.oauth.audience, options.oauth.verify),
    ),
    close: () => rpc.close(),
  };
}
export { startNotificationTrial } from "./events/trial-runner.js";
export { createMacKeychain } from "./events/keychain.js";
export { createServiceNotificationEndpoint } from "./events/service-endpoint.js";

export { createCallbackPreflight, assertCallbackApproval } from "./events/callback-preflight.js";
