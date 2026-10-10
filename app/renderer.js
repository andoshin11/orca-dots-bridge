const $ = (id) => document.getElementById(id);
const statusText = {
  ok: "OK",
  created: "作成",
  updated: "更新",
  skipped: "—",
  action: "要対応",
  error: "エラー",
};
const headlines = {
  ok: "dot から状態を確認できる状態です。",
  action: "セットアップが残っています。下の手順を進めてください。",
  error: "エラーがあります。表の内容を確認してください。",
};

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function render(state) {
  $("headline").textContent = state.busy ? "実行中…" : headlines[state.level];
  const table = $("steps");
  table.replaceChildren(
    ...state.steps.map((s) => {
      const tr = document.createElement("tr");
      tr.append(
        cell(state.labels[s.step] ?? s.step),
        cell(statusText[s.status] ?? s.status, `chip ${s.status}`),
        cell(s.detail, "detail"),
      );
      return tr;
    }),
  );
  $("checked").textContent = state.checkedAt
    ? `最終確認: ${new Date(state.checkedAt).toLocaleString()}`
    : "";
  const tunnel = state.settings.statusTunnelId;
  if (tunnel && !$("statusTunnelId").value) $("statusTunnelId").placeholder = tunnel;
  if (state.settings.notificationTunnelId)
    $("notificationTunnelId").placeholder = state.settings.notificationTunnelId;
  $("pluginTunnel").textContent = tunnel ?? "（Tunnel ID が未設定）";
  const runtimeReady = state.steps.some(
    (s) => s.step === "runtime-key" && ["ok", "created"].includes(s.status),
  );
  if (runtimeReady) $("useClipboardKey").checked = false;
  $("useClipboardKey").disabled = runtimeReady;
  for (const button of document.querySelectorAll("button")) button.disabled = state.busy;
  $("copyTunnel").disabled = !tunnel || state.busy;
  $("restart").disabled =
    state.busy || !state.steps.some((s) => s.step === "launch-agent" && s.status === "ok");
  $("loginItemRow").hidden = !state.packaged;
  $("openAtLogin").checked = state.openAtLogin;
  $("paths").textContent = `bridge: ${state.bridgeDir ?? "—"} ／ node: ${state.nodePath ?? "—"}`;
}

const errorText = {
  clipboard_has_no_runtime_key:
    "クリップボードに runtime キー（sk-…）がありません。Platform でキーをコピーしてから実行してください。",
  invalid_statusTunnelId: "状態確認用の Tunnel ID の形式が違います（tunnel_… ）。",
  invalid_notificationTunnelId: "通知用の Tunnel ID の形式が違います（tunnel_… ）。",
  busy: "別の処理を実行中です。",
};

$("run").addEventListener("click", async () => {
  $("result").textContent = "実行中…";
  const response = await window.bridge.setup({
    statusTunnelId: $("statusTunnelId").value,
    notificationTunnelId: $("notificationTunnelId").value,
    useClipboardKey: $("useClipboardKey").checked,
    installTunnelClient: $("installTunnelClient").checked,
    installAgent: $("installAgent").checked,
  });
  if (response.error) $("result").textContent = errorText[response.error] ?? response.error;
  else {
    const errors = response.steps.filter((s) => s.status === "error").length;
    $("result").textContent = errors ? `${errors} 件のエラーがあります。` : "完了しました。";
    $("statusTunnelId").value = "";
    $("notificationTunnelId").value = "";
  }
  render(response.state);
});
$("doctor").addEventListener("click", async () => {
  const state = await window.bridge.doctor();
  render(state);
  if (state.error) $("headline").textContent = errorText[state.error] ?? "確認に失敗しました。";
});
$("restart").addEventListener("click", async () => {
  const response = await window.bridge.restartAgent();
  $("result").textContent = response.error
    ? (errorText[response.error] ?? "Tunnel を再起動できませんでした。")
    : "Tunnel を再起動しました。";
});
$("copyTunnel").addEventListener("click", () => window.bridge.copy($("pluginTunnel").textContent));
$("openAtLogin").addEventListener("change", async (event) =>
  render(await window.bridge.setOpenAtLogin(event.target.checked)),
);
for (const button of document.querySelectorAll("[data-open]"))
  button.addEventListener("click", () => window.bridge.open(button.dataset.open));

window.bridge.onState(render);
void window.bridge.state().then(render);
