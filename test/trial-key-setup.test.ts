import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { createServiceKeyResolver } from "../src/events/service-key.js";
import {
  apiKeyText,
  KeySetupError,
  runTrialKeySetup,
  setupTrialKeys,
} from "../src/trial-key-setup.js";

function fakeKeys(
  failOn?: string,
  failure = "keychain_account_exists_or_unavailable",
  removeFails = false,
) {
  const stored = new Map<string, Buffer>();
  const removed: string[] = [];
  return {
    stored,
    removed,
    putNew: async (account: string, key: Buffer) => {
      if (account === failOn) {
        // Mirror putNew: only the existence check fails before anything is written.
        if (failure !== "keychain_account_exists_or_unavailable")
          stored.set(account, Buffer.from(key));
        throw new Error(failure);
      }
      stored.set(account, Buffer.from(key));
    },
    remove: async (account: string) => {
      if (removeFails) throw new Error("keychain_delete_failed");
      removed.push(account);
      stored.delete(account);
    },
  };
}
let counter = 0;
const distinct = (size: number) => Buffer.alloc(size, ++counter);

describe("trial key setup", () => {
  test("stores both keys and shows only the service API key", async () => {
    const keys = fakeKeys();
    const shown: string[] = [];
    await setupTrialKeys({ keys, showApiKey: (k) => shown.push(k), random: distinct });

    expect([...keys.stored.keys()]).toEqual(["outbox-v1", "service-v1"]);
    expect(keys.stored.get("outbox-v1")).not.toEqual(keys.stored.get("service-v1"));
    expect(shown).toEqual([keys.stored.get("service-v1")!.toString("base64url")]);
    expect(shown[0]).not.toContain(keys.stored.get("outbox-v1")!.toString("base64url"));
  });

  test("the shown API key authenticates against the service key resolver", async () => {
    const keys = fakeKeys();
    let apiKey = "";
    await setupTrialKeys({ keys, showApiKey: (k) => (apiKey = k) });
    const resolver = createServiceKeyResolver({
      keyId: "trial-service-v1",
      secret: keys.stored.get("service-v1")!,
      expiresAt: Date.now() + 60_000,
    });
    await expect(resolver.resolve(`Bearer ${apiKey}`)).resolves.toBe("service:trial-service-v1");
    await expect(resolver.resolve(`Bearer ${apiKey}x`)).rejects.toThrow("unauthorized");
  });

  test("removes outbox-v1 it created when service-v1 already exists", async () => {
    const keys = fakeKeys("service-v1");
    const shown: string[] = [];
    await expect(
      setupTrialKeys({ keys, showApiKey: (k) => shown.push(k), random: distinct }),
    ).rejects.toThrow("keychain_account_exists_or_unavailable");
    expect(keys.removed).toEqual(["outbox-v1"]);
    expect(keys.stored.size).toBe(0);
    expect(shown).toEqual([]);
  });

  test("creates nothing when outbox-v1 already exists", async () => {
    const keys = fakeKeys("outbox-v1");
    await expect(setupTrialKeys({ keys, showApiKey: () => undefined })).rejects.toThrow(
      "keychain_account_exists_or_unavailable",
    );
    expect(keys.removed).toEqual([]);
    expect(keys.stored.size).toBe(0);
  });

  test("removes both keys when the API key cannot be shown", async () => {
    const keys = fakeKeys();
    await expect(
      setupTrialKeys({
        keys,
        showApiKey: () => {
          throw new Error("terminal_write_failed");
        },
      }),
    ).rejects.toThrow("terminal_write_failed");
    expect(keys.removed).toEqual(["service-v1", "outbox-v1"]);
    expect(keys.stored.size).toBe(0);
  });

  test("zeroes the generated key buffers", async () => {
    const generated: Buffer[] = [];
    await setupTrialKeys({
      keys: fakeKeys(),
      showApiKey: () => undefined,
      random: (size) => {
        const b = Buffer.alloc(size, 9);
        generated.push(b);
        return b;
      },
    });
    for (const b of generated) expect(b.every((byte) => byte === 0)).toBe(true);
  });

  test("the display text carries the key once and a handling warning", () => {
    const apiKey = createHash("sha256").update("k").digest("base64url");
    const text = apiKeyText(apiKey);
    expect(text.split(apiKey)).toHaveLength(2);
    expect(text).toContain("Authorization: Bearer");
  });
});

describe("trial key setup failures after a write", () => {
  test("removes an account whose write succeeded but could not be confirmed", async () => {
    const keys = fakeKeys("service-v1", "keychain_write_unconfirmed");
    const error = await setupTrialKeys({ keys, showApiKey: () => undefined }).catch((e) => e);
    expect(error).toBeInstanceOf(KeySetupError);
    expect(error.message).toBe("keychain_write_unconfirmed");
    expect(error.leftover).toEqual([]);
    expect(keys.removed).toEqual(["service-v1", "outbox-v1"]);
    expect(keys.stored.size).toBe(0);
  });

  test("never removes an account whose write state is unknown, and reports it", async () => {
    const keys = fakeKeys("service-v1", "keychain_timeout");
    const error = await setupTrialKeys({ keys, showApiKey: () => undefined }).catch((e) => e);
    expect(error.message).toBe("keychain_timeout");
    expect(error.leftover).toEqual(["service-v1"]);
    expect(keys.removed).toEqual(["outbox-v1"]);
    expect(keys.stored.has("service-v1")).toBe(true);
  });

  test("reports accounts it could not remove", async () => {
    const keys = fakeKeys("service-v1", "keychain_account_exists_or_unavailable", true);
    const error = await setupTrialKeys({ keys, showApiKey: () => undefined }).catch((e) => e);
    expect(error.leftover).toEqual(["outbox-v1"]);
  });
});

describe("trial-key-setup command", () => {
  function io(stderrIsTerminal: boolean, keys = fakeKeys(), args: string[] = []) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let opened = 0;
    return {
      stdout,
      stderr,
      opened: () => opened,
      keys,
      run: () =>
        runTrialKeySetup({
          args,
          stderrIsTerminal,
          keys: () => {
            opened++;
            return keys;
          },
          writeStdout: (text) => stdout.push(text),
          writeStderr: (bytes) => stderr.push(bytes.toString()),
        }),
    };
  }

  test("refuses a non-terminal stderr before touching the Keychain", async () => {
    const f = io(false);
    expect(await f.run()).toBe(1);
    expect(f.opened()).toBe(0);
    expect(f.stderr).toEqual([]);
    expect(f.stdout).toEqual(["Trial key setup failed: private_terminal_required\n"]);
  });

  test("prints usage for any argument and creates nothing", async () => {
    const f = io(true, fakeKeys(), ["--force"]);
    expect(await f.run()).toBe(1);
    expect(f.opened()).toBe(0);
    expect(f.stdout[0]).toMatch(/^Usage: trial-key-setup/);
  });

  test("shows the API key on stderr only, once", async () => {
    const f = io(true);
    expect(await f.run()).toBe(0);
    const apiKey = f.keys.stored.get("service-v1")!.toString("base64url");
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr[0]).toContain(apiKey);
    expect(f.stdout.join("")).not.toContain(apiKey);
    expect(f.stdout).toEqual(["Trial keys created (outbox-v1, service-v1).\n"]);
  });

  test("names the accounts to check when cleanup is incomplete", async () => {
    const f = io(true, fakeKeys("service-v1", "keychain_timeout"));
    expect(await f.run()).toBe(1);
    expect(f.stdout).toEqual([
      "Trial key setup failed: keychain_timeout (check Keychain accounts: service-v1)\n",
    ]);
    expect(f.stderr).toEqual([]);
  });
});
