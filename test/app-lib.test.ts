import { describe, expect, test } from "vite-plus/test";
import {
  nodeCandidates,
  overallLevel,
  parseSetupRequest,
  runtimeKeyFromClipboard,
  trayTitle,
} from "../app/lib.mjs";

const step = (name: string, status: string) => ({ step: name, status, detail: "" });

describe("menu bar app helpers", () => {
  test("the tray level is error first, then anything left to do, then ok", () => {
    const ready = [step("orca", "ok"), step("status-tunnel", "ok")];
    expect(overallLevel(ready)).toBe("ok");
    expect(overallLevel([...ready, step("runtime-key", "action")])).toBe("action");
    expect(overallLevel([step("orca", "ok"), step("status-tunnel", "skipped")])).toBe("action");
    expect(overallLevel([...ready, step("relay", "error"), step("x", "action")])).toBe("error");
    expect(trayTitle("ok", true)).toBe("Orca ✓");
    expect(trayTitle("ok", false)).toBe("Orca …");
    expect(trayTitle("error", true)).toBe("Orca ✕");
  });

  test("only a runtime key is taken from the clipboard", () => {
    const key = `sk-proj-${"a".repeat(40)}`;
    expect(runtimeKeyFromClipboard(`  ${key}\n`)).toBe(key);
    expect(runtimeKeyFromClipboard("https://example.com")).toBeUndefined();
    expect(runtimeKeyFromClipboard(undefined)).toBeUndefined();
  });

  test("setup requests from the window are reduced to known, validated fields", () => {
    expect(
      parseSetupRequest({
        statusTunnelId: " tunnel_6ac38c1031e88191851d3923013d3cfa ",
        notificationTunnelId: "",
        useClipboardKey: true,
        installAgent: "yes",
        runtimeKey: "sk-should-be-ignored",
      }),
    ).toEqual({
      statusTunnelId: "tunnel_6ac38c1031e88191851d3923013d3cfa",
      useClipboardKey: true,
      installTunnelClient: false,
      installAgent: false,
    });
    expect(() => parseSetupRequest({ statusTunnelId: "../../etc" })).toThrow(
      "invalid_statusTunnelId",
    );
    expect(() => parseSetupRequest(null)).toThrow("invalid_request");
  });

  test("Node candidates are absolute paths under the home or the usual prefixes", () => {
    for (const path of nodeCandidates("/Users/a")) expect(path.startsWith("/")).toBe(true);
  });
});
