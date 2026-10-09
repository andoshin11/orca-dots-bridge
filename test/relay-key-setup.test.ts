import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { setupRelayKey } from "../src/relay-key-setup.js";

function fakeKeys(fail?: "put" | "unconfirmed" | "timeout") {
  const stored = new Map<string, Buffer>();
  return {
    stored,
    putNew: async (account: string, key: Buffer) => {
      if (fail === "put") throw new Error("keychain_account_exists_or_unavailable");
      stored.set(account, Buffer.from(key));
      if (fail === "unconfirmed") throw new Error("keychain_write_unconfirmed");
      if (fail === "timeout") throw new Error("keychain_timeout");
    },
    remove: async (account: string) => {
      stored.delete(account);
    },
  };
}
const fixedKey = () => Buffer.alloc(32, 7);

describe("relay key setup", () => {
  test("stores the key and writes a matching owner-only plugin config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-setup-"));
    const configPath = join(dir, "nested", "config.json");
    const keys = fakeKeys();
    await setupRelayKey({ keys, configPath, relayPort: 8788, random: fixedKey });

    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, string>;
    expect(config).toEqual({
      url: "http://127.0.0.1:8788/relay",
      secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
    });
    expect(keys.stored.get("relay-v1")).toEqual(Buffer.alloc(32, 7));
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  test("refuses to replace an existing plugin config and creates no key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-setup-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "{}");
    const keys = fakeKeys();
    await expect(
      setupRelayKey({ keys, configPath, relayPort: 8788, random: fixedKey }),
    ).rejects.toThrow("relay_config_exists");
    expect(keys.stored.size).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe("{}");
  });

  test("removes the claimed config when the Keychain refuses the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-setup-"));
    const configPath = join(dir, "config.json");
    await expect(
      setupRelayKey({ keys: fakeKeys("put"), configPath, relayPort: 8788, random: fixedKey }),
    ).rejects.toThrow("keychain_account_exists_or_unavailable");
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects ports outside the unprivileged range", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-setup-"));
    for (const relayPort of [80, 70000, 1.5])
      await expect(
        setupRelayKey({ keys: fakeKeys(), configPath: join(dir, "c.json"), relayPort }),
      ).rejects.toThrow("invalid_relay_port");
  });

  test("removes a key whose write succeeded but could not be confirmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-setup-"));
    const keys = fakeKeys("unconfirmed");
    const error = await setupRelayKey({
      keys,
      configPath: join(dir, "config.json"),
      relayPort: 8788,
      random: fixedKey,
    }).catch((e) => e);
    expect(error.message).toBe("keychain_write_unconfirmed");
    expect(error.leftover).toEqual([]);
    expect(keys.stored.size).toBe(0);
  });

  test("keeps and reports a key whose write state is unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-setup-"));
    const configPath = join(dir, "config.json");
    const keys = fakeKeys("timeout");
    const error = await setupRelayKey({
      keys,
      configPath,
      relayPort: 8788,
      random: fixedKey,
    }).catch((e) => e);
    expect(error.leftover).toEqual(["relay-v1"]);
    expect(keys.stored.has("relay-v1")).toBe(true);
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
