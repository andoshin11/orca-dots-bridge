import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { runTwoPhaseCli } from "../src/notification-two-phase.js";
import { startTwoPhaseTrial } from "../src/events/trial-runner.js";
function fixture() {
  const input = new PassThrough(),
    signals = new EventEmitter();
  let finish!: () => void;
  const finished = new Promise<void>((r) => {
    finish = r;
  });
  const output = vi.fn(),
    review = vi.fn(),
    failed = vi.fn();
  const trial = {
    close: vi.fn(async () => {
      finish();
    }),
    finished,
    activate: vi.fn(async () => ({})),
    deleteTrialKeys: vi.fn(),
  };
  let show: (url: string) => void = () => {};
  const start = vi.fn(async (_config, _runtime, callback) => {
    show = callback;
    return trial;
  });
  const io = { input, signals, output, review, failed, privateTerminal: () => true };
  const write = (value: unknown) => input.write(JSON.stringify(value) + "\n");
  return {
    io,
    trial,
    start,
    finish: () => finish(),
    write,
    show: (url: string) => show(url),
    run: () => runTwoPhaseCli(io, start as typeof startTwoPhaseTrial),
  };
}
it("keeps private URL out of stdout and passes only the separate second approval to the same runner", async () => {
  const f = fixture();
  const done = f.run();
  f.write({ config: { synthetic: true }, runtimeToken: "synthetic-secret" });
  await vi.waitFor(() =>
    expect(f.io.output).toHaveBeenCalledWith("Two-phase ready; verification only.\n"),
  );
  f.show("https://receiver.example.com/private-path");
  expect(f.io.review.mock.calls[0]![0]).toContain("/private-path");
  expect(JSON.stringify(f.io.output.mock.calls)).not.toContain("/private-path");
  f.write({
    command: "activate",
    approval: { privateUrl: "https://receiver.example.com/private-path" },
  });
  await vi.waitFor(() => expect(f.trial.activate).toHaveBeenCalledTimes(1));
  f.finish();
  await done;
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.io.failed).not.toHaveBeenCalled();
  expect(f.trial.deleteTrialKeys).not.toHaveBeenCalled();
});
it.each(["SIGINT", "SIGTERM", "EOF", "oversize", "bad_input"])(
  "stops safely on %s and never logs arbitrary input",
  async (mode) => {
    const f = fixture();
    const done = f.run();
    f.write({ config: {}, runtimeToken: "synthetic-secret" });
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    if (mode === "EOF") f.io.input.end();
    else if (mode === "oversize") f.io.input.write("x".repeat(65537));
    else if (mode === "bad_input") f.io.input.write("private-poison-invalid-json\n");
    else f.io.signals.emit(mode);
    await done;
    expect(f.trial.close).toHaveBeenCalled();
    expect(f.trial.activate).not.toHaveBeenCalled();
    expect(JSON.stringify(f.io.output.mock.calls)).not.toContain("private-poison");
    expect(f.io.signals.listenerCount("SIGINT")).toBe(0);
  },
);
it("refuses nonprivate output before starting or reading a key", async () => {
  const f = fixture();
  f.io.privateTerminal = () => false;
  await expect(f.run()).rejects.toThrow("review_terminal_unavailable");
  expect(f.start).not.toHaveBeenCalled();
});
it("rejects a third record without a second activation", async () => {
  const f = fixture();
  const done = f.run();
  f.write({ config: {}, runtimeToken: "synthetic-secret" });
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  f.write({ command: "activate", approval: {} });
  await vi.waitFor(() => expect(f.trial.activate).toHaveBeenCalledTimes(1));
  f.write({ command: "activate", approval: {} });
  await done;
  expect(f.trial.activate).toHaveBeenCalledTimes(1);
  expect(f.io.failed).toHaveBeenCalled();
});
