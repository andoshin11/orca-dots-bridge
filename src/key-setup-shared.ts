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
