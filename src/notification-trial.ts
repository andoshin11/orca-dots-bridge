import { startNotificationTrial } from "./events/trial-runner.js";
import { z } from "zod";
const inputSchema = z.object({ config: z.unknown(), runtimeToken: z.string().min(1) }).strict();
// User-launched only: JSON arrives through stdin, never argv or a chat/tool invocation.
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65536) throw new Error("input_limit");
  }
  const parsed = inputSchema.parse(JSON.parse(input));
  input = "";
  const trial = await startNotificationTrial(parsed.config, parsed.runtimeToken);
  parsed.runtimeToken = "";
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await trial.close();
      process.exitCode = 0;
    } catch {
      process.stderr.write(
        "試験プロセスの終了を確認できません。再実行せずChatGPTへ確認を依頼してください。\n",
      );
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.stdout.write("Notification trial started on loopback; stops within ten minutes.\n");
  await trial.finished;
  process.stdout.write(
    "通知試験を終了しました。専用Tunnelの終了と試験タスクの停止を確認してください。キーは保持します。\n",
  );
}
void main().catch(() => {
  process.stderr.write("通知試験を続行できず停止しました。認証情報は表示していません。\n");
  process.exitCode = 1;
});
