import { describe, expect, test } from "vite-plus/test";
import {
  needsAgentRefresh,
  nodeCandidates,
  overallLevel,
  parseSetupRequest,
  runtimeKeyFromClipboard,
  trayTitle,
} from "../app/lib.mjs";

const step = (name: string, status: string) => ({ step: name, status, detail: "" });

describe("menu bar app helpers", () => {
  test("the tray level is error first, then anything left to do, then ok", () => {
    const ready = [step("orca", "ok"), step("tunnel", "ok")];
    expect(overallLevel(ready)).toBe("ok");
    expect(overallLevel([...ready, step("runtime-key", "action")])).toBe("action");
    expect(overallLevel([step("orca", "ok"), step("tunnel", "skipped")])).toBe("action");
    expect(overallLevel([...ready, step("relay", "error"), step("x", "action")])).toBe("error");
    expect(trayTitle("ok", true)).toBe("Orca ✓");
    expect(trayTitle("ok", false)).toBe("Orca …");
    expect(trayTitle("error", true)).toBe("Orca ✕");
  });

  test("only a runtime key is taken from the clipboard", () => {
    const key = `sk-test-${"a".repeat(40)}`;
    expect(runtimeKeyFromClipboard(`  ${key}\n`)).toBe(key);
    expect(runtimeKeyFromClipboard("https://example.com")).toBeUndefined();
    expect(runtimeKeyFromClipboard(undefined)).toBeUndefined();
  });

  test("setup requests from the window are reduced to known, validated fields", () => {
    expect(
      parseSetupRequest({
        tunnelId: " tunnel_00000000000000000000000000000001 ",
        notificationTunnelId: "tunnel_00000000000000000000000000000002",
        installNotifications: true,
        useClipboardKey: true,
        installAgent: "yes",
        runtimeKey: "sk-should-be-ignored",
      }),
    ).toEqual({
      tunnelId: "tunnel_00000000000000000000000000000001",
      useClipboardKey: true,
      replaceRuntimeKey: false,
      installTunnelClient: false,
      installAgent: false,
    });
    expect(parseSetupRequest({ useClipboardKey: true, replaceRuntimeKey: true })).toMatchObject({
      replaceRuntimeKey: true,
    });
    // Rotation without a copied key is meaningless and is dropped.
    expect(parseSetupRequest({ replaceRuntimeKey: true })).toMatchObject({
      replaceRuntimeKey: false,
    });
    expect(() => parseSetupRequest({ tunnelId: "../../etc" })).toThrow("invalid_tunnelId");
    expect(() => parseSetupRequest(null)).toThrow("invalid_request");
  });

  test("setup reruns on its own only for an earlier layout still running or a moved runtime", () => {
    const detail = (name: string, status: string, text: string) => ({
      step: name,
      status,
      detail: text,
    });
    expect(
      needsAgentRefresh([
        detail(
          "legacy-status-tunnel",
          "action",
          "dev.orca-dots-bridge.status-tunnel is still loaded (rerun with --install-agent to move to the single Tunnel)",
        ),
      ]),
    ).toBe(true);
    expect(
      needsAgentRefresh([detail("service", "action", "outdated (rerun with --install-agent)")]),
    ).toBe(true);
    // Leftover files alone, or a service that was never installed, wait for the person.
    expect(
      needsAgentRefresh([detail("legacy-profiles", "action", "/x/orca-status.yaml remain")]),
    ).toBe(false);
    expect(needsAgentRefresh([detail("service", "skipped", "rerun with --install-agent")])).toBe(
      false,
    );
    expect(needsAgentRefresh([detail("service", "action", "needs the service keys")])).toBe(false);
  });

  test("Node candidates are absolute paths under the home or the usual prefixes", () => {
    for (const path of nodeCandidates("/Users/a")) expect(path.startsWith("/")).toBe(true);
  });
});
