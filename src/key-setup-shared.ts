import { randomBytes } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KeyAccount } from "./events/keychain.js";

// Shared by the key setup commands. Kept free of a main entry so bundling it
// into a common chunk never moves a command's entry point.

export type SetupKeys = {
  putNew(account: KeyAccount, key: Buffer): Promise<void>;
  remove(account: KeyAccount): Promise<void>;
};

/** Thrown with the accounts the user has to check by hand (names only, never key material). */
export class KeySetupError extends Error {
  constructor(
    code: string,
    readonly leftover: KeyAccount[],
  ) {
    super(code);
  }
}

/**
 * Stores one key with putNew and reports whether a failure may have left it in
 * the Keychain. putNew names its errors by phase: nothing is written before
 * "keychain_write_unconfirmed" can occur, and a refused `add`
 * ("keychain_write_failed") wrote nothing.
 */
export async function putOwned(keys: SetupKeys, account: KeyAccount, key: Buffer) {
  try {
    await keys.putNew(account, key);
    return { ok: true as const };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return {
      ok: false as const,
      error,
      written:
        code === "keychain_write_unconfirmed"
          ? ("yes" as const)
          : [
                "keychain_account_exists_or_unavailable",
                "keychain_write_failed",
                "invalid_keychain_key",
                "invalid_key_account",
              ].includes(code)
            ? ("no" as const)
            : ("unknown" as const),
    };
  }
}

/** Error code safe to print: fixed snake_case codes only. */
export function setupErrorCode(error: unknown, fallback: string) {
  return error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : fallback;
}

/**
 * Creates the two notification-trial keys in the Keychain:
 * - outbox-v1 seals the trial's event outbox and is never shown.
 * - service-v1 authenticates the dot plugin; its API key is handed to
 *   `showApiKey` exactly once, for the user to enter on the product side.
 * Refuses to overwrite either account and removes what it created if a later
 * step fails. An account whose state it cannot establish is never removed
 * (it could be one that existed before); it is reported instead.
 */
export async function setupTrialKeys(options: {
  keys: SetupKeys;
  showApiKey: (apiKey: string) => void;
  random?: (size: number) => Buffer;
}) {
  const random = options.random ?? randomBytes;
  const outbox = random(32);
  const service = random(32);
  const created: KeyAccount[] = [];
  const uncertain: KeyAccount[] = [];
  const store = async (account: KeyAccount, key: Buffer) => {
    const result = await putOwned(options.keys, account, key);
    if (result.ok) {
      created.push(account);
      return;
    }
    if (result.written === "yes") created.push(account);
    if (result.written === "unknown") uncertain.push(account);
    throw result.error;
  };
  try {
    await store("outbox-v1", outbox);
    await store("service-v1", service);
    // The service resolver expects `Authorization: Bearer <base64url(key)>`.
    // The string form cannot be zeroed; the process exits right after setup.
    options.showApiKey(service.toString("base64url"));
  } catch (error) {
    const leftover = [...uncertain];
    for (const account of created.reverse()) {
      try {
        await options.keys.remove(account);
      } catch {
        leftover.push(account);
      }
    }
    throw new KeySetupError(setupErrorCode(error, "trial_key_setup_failed"), leftover);
  } finally {
    outbox.fill(0);
    service.fill(0);
  }
}

export const defaultRelayConfigPath = () =>
  join(homedir(), ".config", "orca-agent-status-relay", "config.json");

/**
 * Creates the relay signing key in the Keychain and writes the plugin config
 * that carries the same key, so the secret is never shown, typed or passed on
 * argv. Refuses to overwrite either an existing Keychain account or config file.
 */
export async function setupRelayKey(options: {
  keys: {
    putNew(account: KeyAccount, key: Buffer): Promise<void>;
    remove(account: KeyAccount): Promise<void>;
  };
  configPath: string;
  relayPort: number;
  random?: (size: number) => Buffer;
}) {
  if (!Number.isInteger(options.relayPort) || options.relayPort < 1024 || options.relayPort > 65535)
    throw new Error("invalid_relay_port");
  await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
  // Claim the config path first so an existing plugin config is never replaced.
  const file = await open(options.configPath, "wx", 0o600).catch((error: unknown) => {
    throw new Error(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "relay_config_exists"
        : "relay_config_unwritable",
    );
  });
  const key = (options.random ?? randomBytes)(32);
  let stored = false;
  let uncertain = false;
  try {
    const result = await putOwned(options.keys, "relay-v1", key);
    if (!result.ok) {
      stored = result.written === "yes";
      uncertain = result.written === "unknown";
      throw result.error;
    }
    stored = true;
    const config = {
      url: `http://127.0.0.1:${options.relayPort}/relay`,
      secret: `whsec_${key.toString("base64")}`,
    };
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(options.configPath).catch(() => undefined);
    // Never leave a Keychain key that no plugin config carries. A key whose write
    // state is unknown is not removed (it may predate this run); it is reported.
    let leftover = uncertain;
    if (stored) {
      try {
        await options.keys.remove("relay-v1");
      } catch {
        leftover = true;
      }
    }
    throw new KeySetupError(
      setupErrorCode(error, "relay_setup_failed"),
      leftover ? ["relay-v1"] : [],
    );
  } finally {
    key.fill(0);
  }
}
