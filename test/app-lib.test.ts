import { describe, expect, test } from "vite-plus/test";
import {
  auditViewLimit,
  formatAuditEntry,
  needsAgentRefresh,
  nodeCandidates,
  overallLevel,
  parseAuditLog,
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

describe("操作の記録", () => {
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({
      time: "2026-10-11T09:30:00.000Z",
      source: "chatgpt",
      tool: "orca_send_instruction",
      outcome: "ok",
      ...over,
    });

  test("keeps only well-formed entries of known tools, newest first, bounded", () => {
    const older = [line({ summary: "old" }), "garbage"].join("\n");
    const current = [
      line({ tool: "rm_everything" }),
      line({ outcome: "maybe" }),
      line({ source: "web" }),
      line({ summary: "new", target: { handle: "term_1", "bad key": "x", nested: { a: 1 } } }),
      "",
    ].join("\n");
    const entries = parseAuditLog([older, current]);
    expect(entries.map((e) => e.summary)).toEqual(["new", "old"]);
    expect(entries[0]!.target).toEqual({ handle: "term_1" });
    const many = Array.from({ length: 40 }, (_, i) => line({ summary: String(i) })).join("\n");
    const limited = parseAuditLog([many]);
    expect(limited).toHaveLength(auditViewLimit);
    expect(limited[0]!.summary).toBe("39");
    expect(parseAuditLog([undefined, ""])).toEqual([]);
  });

  test("strips control characters and clips the summary", () => {
    const [entry] = parseAuditLog([line({ summary: `a\u001b[31mb${"x".repeat(400)}` })]);
    expect(entry!.summary).not.toContain("\u001b");
    expect(Array.from(entry!.summary!)).toHaveLength(200);
  });

  test("formats rows in Japanese wording", () => {
    const [send, task, settings, close] = parseAuditLog([
      [
        line({
          tool: "orca_close_agent",
          outcome: "refused",
          errorCode: "close_disabled",
          target: { worktreeId: "repo::/w/x", allInWorkspace: true },
        }),
        line({ tool: "orca_settings_update", target: { sendEnabled: true, removeEnabled: false } }),
        line({
          tool: "orca_start_task",
          source: "stdio",
          outcome: "error",
          errorCode: "create_outcome_unknown",
          target: { repo: "r", template: "issue", issue: 12, workspace: "issue-12" },
        }),
        line({ target: { handle: "term_1", worktreeId: "w" }, summary: "テストを直して" }),
      ].join("\n"),
    ]);
    expect(formatAuditEntry(send!)).toMatchObject({
      tool: "指示の送信",
      target: "term_1",
      outcome: "完了",
      outcomeClass: "ok",
      source: "ChatGPT",
      summary: "テストを直して",
    });
    expect(formatAuditEntry(task!)).toMatchObject({
      tool: "タスクの開始",
      target: "r / issue-12 / 型 issue / Issue #12",
      outcome: "エラー（create_outcome_unknown）",
      source: "stdio",
    });
    expect(formatAuditEntry(settings!)).toMatchObject({
      tool: "設定の変更",
      target: "指示の送信: オン、ワークスペースの削除: オフ",
      summary: "",
    });
    expect(formatAuditEntry(close!)).toMatchObject({
      tool: "エージェントの終了",
      target: "すべてのターミナル",
      outcome: "拒否（close_disabled）",
    });
    expect(formatAuditEntry(send!).time).toMatch(/\d/);
  });
});
