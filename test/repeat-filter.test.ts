import { expect, it } from "vite-plus/test";
import { createRepeatFilter } from "../src/events/pane-rpc.js";

it("drops a same-kind status for the same pane within the window", () => {
  const repeated = createRepeatFilter(5000);
  expect(repeated("tab:leaf", "turn_finished", 1000)).toBe(false);
  expect(repeated("tab:leaf", "turn_finished", 2300)).toBe(true);
  // Another pane, another kind, or a later turn still goes through.
  expect(repeated("tab:other", "turn_finished", 2300)).toBe(false);
  expect(repeated("tab:leaf", "input_required", 2400)).toBe(false);
  expect(repeated("tab:leaf", "turn_finished", 9000)).toBe(false);
});
