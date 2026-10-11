import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  auditOutcome,
  createAuditLog,
  describeCall,
  parseAuditLines,
  type AuditLog,
} from "../src/audit.js";
import { BridgeError } from "../src/errors.js";
import { callTool, defineTool, settingsToolDefinitions } from "../src/tools.js";
import { z } from "zod";

const tempDir = () => mkdtemp(join(tmpdir(), "audit-"));
const fixedClock = () => Date.UTC(2026, 9, 11, 9, 30);

describe("audit log file", () => {
  test("appends JSON Lines, owner-only, with the injected clock", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "audit.log");
    const log = createAuditLog(path, fixedClock);
    log.record({ source: "chatgpt", tool: "orca_remove_alias", outcome: "ok" });
    log.record({ source: "stdio", tool: "orca_set_alias", outcome: "refused", errorCode: "x_y" });
    await log.flush();
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        time: "2026-10-11T09:30:00.000Z",
        source: "chatgpt",
        tool: "orca_remove_alias",
        outcome: "ok",
      },
      {
        time: "2026-10-11T09:30:00.000Z",
        source: "stdio",
        tool: "orca_set_alias",
        outcome: "refused",
        errorCode: "x_y",
      },
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await log.read()).map((e) => e.tool)).toEqual(["orca_set_alias", "orca_remove_alias"]);
  });

  test("tightens an existing file to 600", async () => {
    const dir = await tempDir();
    const path = join(dir, "audit.log");
    await writeFile(path, "", { mode: 0o644 });
    const log = createAuditLog(path, fixedClock);
    log.record({ source: "chatgpt", tool: "orca_answer", outcome: "ok" });
    await log.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("rotates past the size limit, keeping one previous file, and reads across both", async () => {
    const dir = await tempDir();
    const path = join(dir, "audit.log");
    const log = createAuditLog(path, fixedClock, 400);
    for (let i = 0; i < 12; i++)
      log.record({
        source: "chatgpt",
        tool: "orca_send_instruction",
        outcome: "ok",
        summary: `instruction ${i}`,
      });
    await log.flush();
    expect((await stat(path)).size).toBeLessThanOrEqual(400);
    expect((await stat(`${path}.1`)).size).toBeLessThanOrEqual(400);
    const all = await log.read({ limit: 100 });
    // Only the current and one previous file survive; the newest come first.
    expect(all[0]?.summary).toBe("instruction 11");
    expect(all.length).toBeLessThan(12);
    expect(all.map((e) => Number(e.summary!.split(" ")[1]))).toEqual(
      all.map((e) => Number(e.summary!.split(" ")[1])).sort((a, b) => b - a),
    );
  });

  test("never writes through or reads from a symlink", async () => {
    const dir = await tempDir();
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "untouched\n");
    const path = join(dir, "audit.log");
    await symlink(victim, path);
    const log = createAuditLog(path, fixedClock);
    log.record({ source: "chatgpt", tool: "orca_answer", outcome: "ok" });
    await log.flush();
    expect(await readFile(victim, "utf8")).toBe("untouched\n");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await log.read()).toEqual([]);
  });

  test("a failing disk never throws from record", async () => {
    const dir = await tempDir();
    // The parent "directory" is a file: every write fails.
    await writeFile(join(dir, "file"), "x");
    const log = createAuditLog(join(dir, "file", "audit.log"), fixedClock);
    expect(() =>
      log.record({ source: "chatgpt", tool: "orca_answer", outcome: "ok" }),
    ).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    await expect(log.read()).resolves.toEqual([]);
  });

  test("reading skips malformed lines and unknown tools, and filters by tool", async () => {
    const dir = await tempDir();
    const path = join(dir, "audit.log");
    const good = (tool: string) =>
      JSON.stringify({ time: "t", source: "chatgpt", tool, outcome: "ok" });
    await writeFile(
      path,
      [
        "not json",
        good("orca_answer"),
        good("rm_rf"),
        JSON.stringify({ time: "t", source: "web", tool: "orca_answer", outcome: "ok" }),
        good("orca_start_task"),
        good("orca_answer"),
        "",
      ].join("\n"),
    );
    const log = createAuditLog(path, fixedClock);
    expect((await log.read()).map((e) => e.tool)).toEqual([
      "orca_answer",
      "orca_start_task",
      "orca_answer",
    ]);
    expect(await log.read({ tool: "orca_start_task" })).toHaveLength(1);
    expect(await log.read({ limit: 1 })).toHaveLength(1);
    expect(
      parseAuditLines('{"time":"t","source":"stdio","tool":"orca_answer","outcome":"bad"}'),
    ).toEqual([]);
  });
});

describe("what an entry holds", () => {
  test("instruction and answer text is clipped to 200 characters on one line", () => {
    const long = "あ".repeat(300);
    const send = describeCall("orca_send_instruction", {
      handle: "term_1",
      expectedWorktreeId: "wt_1",
      text: `line one\n${long}`,
    });
    expect(send.target).toEqual({ handle: "term_1", worktreeId: "wt_1" });
    expect(Array.from(send.summary!)).toHaveLength(200);
    expect(send.summary!.startsWith("line one あ")).toBe(true);
    expect(send.summary!.endsWith("…")).toBe(true);
    expect(
      describeCall(
        "orca_answer",
        { handle: "term_1", expectedWorktreeId: "wt_1", option: 2 },
        { chosenLabel: "Yes, and don't ask again" },
      ),
    ).toEqual({
      target: { handle: "term_1", worktreeId: "wt_1", option: 2 },
      summary: "2. Yes, and don't ask again",
    });
  });

  test("workspace targets come from the result when the call succeeded", () => {
    expect(
      describeCall(
        "orca_start_task",
        { repo: "r", template: "issue", issue: 12, note: "テストも足して" },
        {
          workspace: "issue-12",
          agent: "claude",
          worktreeId: "r::/w/issue-12",
          terminalHandle: "term_9",
        },
      ),
    ).toEqual({
      target: {
        repo: "r",
        template: "issue",
        issue: 12,
        workspace: "issue-12",
        agent: "claude",
        worktreeId: "r::/w/issue-12",
        handle: "term_9",
      },
      summary: "テストも足して",
    });
    expect(describeCall("orca_close_agent", { allInWorkspace: true, worktreeId: "wt" })).toEqual({
      target: { worktreeId: "wt", allInWorkspace: true },
    });
  });

  test("settings changes record only boolean switches, never other values", () => {
    expect(
      describeCall("orca_settings_update", {
        set: { sendEnabled: true, removeEnabled: false, secret: "whsec_x", "bad key": true },
      }),
    ).toEqual({
      target: { sendEnabled: true, removeEnabled: false },
      summary: "sendEnabled=true, removeEnabled=false",
    });
  });

  test("invalid arguments are described without trusting their types", () => {
    expect(describeCall("orca_send_instruction", { handle: { x: 1 }, text: 42 })).toEqual({});
    expect(describeCall("orca_remove_alias", "nonsense")).toEqual({});
  });

  test("outcome classes", () => {
    expect(auditOutcome("send_disabled")).toBe("refused");
    expect(auditOutcome("invalid_input")).toBe("refused");
    expect(auditOutcome("create_outcome_unknown")).toBe("error");
    expect(auditOutcome("internal_error")).toBe("error");
    expect(auditOutcome("cli_missing")).toBe("error");
  });
});

describe("callTool records write tools only", () => {
  const memory = () => {
    const entries: Parameters<AuditLog["record"]>[0][] = [];
    const log: AuditLog = {
      record: (e) => void entries.push(e),
      flush: async () => undefined,
      read: async () => [],
    };
    return { log, entries };
  };
  const tool = (name: string, run: () => Promise<never> | Promise<{ content: [] }>) =>
    defineTool({
      name,
      description: "",
      inputShape: { text: z.string().max(5) },
      annotations: {},
      run: run as never,
    });

  test("ok, refused, error and invalid input", async () => {
    const { log, entries } = memory();
    const ctx = { audit: log, source: "stdio" as const };
    const ok = tool(
      "orca_send_instruction",
      async () =>
        ({
          content: [{ type: "text", text: JSON.stringify({ accepted: true }) }],
        }) as never,
    );
    const notAccepted = tool(
      "orca_send_instruction",
      async () =>
        ({
          content: [{ type: "text", text: JSON.stringify({ accepted: false }) }],
        }) as never,
    );
    const refused = tool("orca_send_instruction", async () => {
      throw new BridgeError("send_disabled", "off");
    });
    const crashed = tool("orca_send_instruction", async () => {
      throw new Error("boom");
    });
    await callTool(ok, { text: "hi" }, undefined, ctx);
    await callTool(notAccepted, { text: "hi" }, undefined, ctx);
    await callTool(refused, { text: "hi" }, undefined, ctx);
    await callTool(crashed, { text: "hi" }, undefined, ctx);
    await callTool(ok, { text: "too long" }, undefined, ctx);
    expect(entries.map((e) => [e.outcome, e.errorCode, e.summary])).toEqual([
      ["ok", undefined, "hi"],
      ["refused", "not_accepted", "hi"],
      ["refused", "send_disabled", "hi"],
      ["error", "internal_error", "hi"],
      ["refused", "invalid_input", "too long"],
    ]);
    expect(entries.every((e) => e.source === "stdio")).toBe(true);
    // Read-only tools and calls without an audit log are not recorded.
    await callTool(tool("orca_find", ok.run as never), { text: "x" }, undefined, ctx);
    await callTool(ok, { text: "x" }, undefined);
    expect(entries).toHaveLength(5);
  });

  test("a throwing audit log never fails the call", async () => {
    const broken: AuditLog = {
      record: () => {
        throw new Error("disk full");
      },
      flush: async () => undefined,
      read: async () => [],
    };
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    const [, update] = settingsToolDefinitions(join(dir, "s.json"));
    const result = await callTool(update!, { set: { sendEnabled: false } }, undefined, {
      audit: broken,
      source: "chatgpt",
    });
    expect(result.isError).toBeUndefined();
  });
});
