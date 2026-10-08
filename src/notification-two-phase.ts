import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { startTwoPhaseTrial } from "./events/trial-runner.js";

const first = z.object({ config: z.unknown(), runtimeToken: z.string().min(1) }).strict();
const next = z.object({ command: z.literal("activate"), approval: z.unknown() }).strict();
export function privateReviewText(url: string) {
  if (!/^[\x21-\x7e]+$/.test(url) || url.length > 4096) throw new Error("review_invalid");
  return (
    "\n【確認通信が成功しました。通知・監視はまだ無効です】\n" +
    "URL全文はチャットへ貼らず、後の非表示欄へ入力してください。本人アカウントへの帰属は確認応答だけでは証明できません。\n" +
    url +
    "\n"
  );
}
/** User-launched only. Initial scope and later approval are separate bounded stdin records. */
export async function runTwoPhaseCli(
  io: {
    input: Readable;
    output: (text: string) => void;
    review: (text: string) => void;
    privateTerminal: () => boolean;
    failed: () => void;
    signals: EventEmitter;
  },
  start: typeof startTwoPhaseTrial = startTwoPhaseTrial,
) {
  if (!io.privateTerminal()) throw new Error("review_terminal_unavailable");
  let trial: Awaited<ReturnType<typeof startTwoPhaseTrial>> | undefined;
  let closing = false,
    activated = false,
    records = 0,
    total = 0,
    buffer = "";
  let chain = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>((r) => {
    finish = r;
  });
  const stop = async () => {
    if (closing) return;
    closing = true;
    try {
      await trial?.close();
    } catch {
      io.failed();
    } finally {
      io.input.destroy();
      finish();
    }
  };
  const fail = () => {
    io.output("Two-phase failure; stopped.\n");
    io.failed();
    void stop();
  };
  const signalStop = () => void stop();
  io.signals.once("SIGINT", signalStop);
  io.signals.once("SIGTERM", signalStop);
  io.input.setEncoding("utf8");
  io.input.on("data", (chunk: string) => {
    if (closing) return;
    total += Buffer.byteLength(chunk);
    if (total > 65536) {
      fail();
      return;
    }
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (++records > 2) {
        fail();
        return;
      }
      chain = chain
        .then(async () => {
          if (closing) return;
          if (!trial) {
            const value = first.parse(JSON.parse(line));
            trial = await start(value.config, value.runtimeToken, (url) => {
              io.review(privateReviewText(url));
              io.output("Two-phase verified; notification approval required.\n");
            });
            value.runtimeToken = "";
            if (closing) {
              await trial.close();
              return;
            }
            void trial.finished.then(
              () => stop(),
              () => {
                io.failed();
                void stop();
              },
            );
            io.output("Two-phase ready; verification only.\n");
          } else {
            if (activated) throw new Error("activation_rejected");
            activated = true;
            const value = next.parse(JSON.parse(line));
            await trial.activate(value.approval);
            io.output("Two-phase active; monitoring started.\n");
          }
        })
        .catch(fail);
    }
  });
  io.input.once("end", () => void stop());
  io.input.once("error", fail);
  await done;
  await chain;
  await trial?.close();
  io.signals.removeListener("SIGINT", signalStop);
  io.signals.removeListener("SIGTERM", signalStop);
  io.output("Two-phase stopped; keys retained.\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runTwoPhaseCli({
    input: process.stdin,
    output: (text) => {
      process.stdout.write(text);
    },
    review: (text) => {
      const bytes = Buffer.from(text);
      for (let offset = 0; offset < bytes.length;)
        offset += writeSync(2, bytes, offset, bytes.length - offset);
    },
    privateTerminal: () => isatty(2),
    failed: () => {
      process.exitCode = 1;
    },
    signals: process,
  }).catch(() => {
    process.stdout.write("Two-phase failure; stopped.\n");
    process.exitCode = 1;
  });
}
