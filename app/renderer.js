const $ = (id) => document.getElementById(id);
let runtimeKeyStored = false;
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
  const tunnel = state.settings.tunnelId;
  if (tunnel && !$("tunnelId").value) $("tunnelId").placeholder = tunnel;
  $("pluginTunnel").textContent = tunnel ?? "（Tunnel ID が未設定）";
  const runtimeReady = state.steps.some(
    (s) => s.step === "runtime-key" && ["ok", "created"].includes(s.status),
  );
  // With a stored key, the same checkbox rotates it to the copied one.
  $("useClipboardKeyLabel").textContent = runtimeReady
    ? " コピーした新しいキーに入れ替える"
    : " コピーしたキーを使う";
  runtimeKeyStored = runtimeReady;
  for (const button of document.querySelectorAll("button")) button.disabled = state.busy;
  $("copyTunnel").disabled = !tunnel || state.busy;
  $("restart").disabled =
    state.busy || !state.steps.some((s) => s.step === "tunnel-agent" && s.status === "ok");
  $("loginItemRow").hidden = !state.packaged;
  $("openAtLogin").checked = state.openAtLogin;
  renderUpdate(state.update, state.busy);
  $("paths").textContent = `bridge: ${state.bridgeDir ?? "—"} ／ node: ${state.nodePath ?? "—"}`;
}

const updatePhaseText = {
  brew: "Homebrew で更新しています…（終わるとアプリを開き直します）",
  download: "ダウンロードしています…",
  verify: "ダウンロードしたアプリを確認しています…",
  install: "置き換えのためにアプリを終了します…",
};
const manualUpdateText =
  "リリースノートのページから zip をダウンロードし、Finder で「Orca Dots Bridge.app」を置き換えてください。";
const updateErrorText = {
  check_failed: "アップデートを確認できませんでした。ネットワークを確認してください。",
  rate_limited: "GitHub の利用制限にかかりました。しばらくしてからもう一度確認してください。",
  busy: "別の処理を実行中です。終わってからもう一度押してください。",
  brew_not_found: "Homebrew（brew）が見つかりません。ターミナルで次を実行してください: ",
  brew_failed: "Homebrew での更新に失敗しました。ターミナルで次を実行してください: ",
  brew_no_change:
    "Homebrew にまだ新しい版が届いていません。少し待ってから、ターミナルで brew update のあと次を実行してください: ",
  translocated: `アプリが一時的な場所で実行されているため、置き換えられません。${manualUpdateText}`,
  not_writable: `アプリのあるフォルダに書き込めないため、置き換えられません（管理者権限では実行しません）。${manualUpdateText}`,
  unexpected_name: `アプリの名前が「Orca Dots Bridge.app」ではないため、置き換えられません。${manualUpdateText}`,
  not_an_app_bundle: `アプリの場所を確かめられないため、置き換えられません。${manualUpdateText}`,
  unsupported: `この環境では自動で置き換えられません。${manualUpdateText}`,
  download_failed: "ダウンロードに失敗しました。ネットワークを確認して、もう一度押してください。",
  download_too_large: "ダウンロードしたファイルが大きすぎるため、中止しました。",
  checksum_missing: "SHA256SUMS に対象のファイルがないため、更新を中止しました。",
  checksum_mismatch: "ダウンロードしたファイルが SHA256SUMS と一致しないため、更新を中止しました。",
  bundle_invalid: "ダウンロードしたアプリの形が想定と違うため、更新を中止しました。",
  identifier_mismatch: "ダウンロードしたアプリの識別子が違うため、更新を中止しました。",
  version_mismatch: "ダウンロードしたアプリの版がリリースと違うため、更新を中止しました。",
  signature_invalid: "ダウンロードしたアプリの署名を確認できないため、更新を中止しました。",
  install_failed: `更新を完了できませんでした（元の版のままです）。${manualUpdateText}`,
};

function renderUpdate(update, busy) {
  $("updateRow").hidden = !update?.supported;
  $("updateBanner").hidden = true;
  if (!update?.supported) return;
  $("autoCheck").checked = update.autoCheck;
  $("checkUpdate").disabled = busy || update.checking || Boolean(update.phase);
  $("checkUpdate").textContent = update.checking ? "確認中…" : "アップデートを確認";
  $("updateChecked").textContent = `今の版: v${update.currentVersion}${
    update.lastCheckedAt ? ` ／ 最終確認: ${new Date(update.lastCheckedAt).toLocaleString()}` : ""
  }`;
  const available = update.available;
  $("updateBanner").hidden = !(available || update.error || update.notice || update.phase);
  $("updateTitle").textContent = available
    ? `新しい版 v${available.version} があります（今は v${update.currentVersion}）。`
    : update.notice === "updated"
      ? `v${update.currentVersion} に更新しました。`
      : update.notice === "up_to_date"
        ? `最新の版です（v${update.currentVersion}）。`
        : "アップデート";
  $("updateActions").hidden = !available;
  $("installUpdate").textContent =
    update.method === "homebrew" ? "Homebrew で更新" : "ダウンロードして更新";
  $("installUpdate").disabled = busy || Boolean(update.phase);
  $("skipUpdate").disabled = Boolean(update.phase);
  const error = update.error
    ? (updateErrorText[update.error] ?? "更新に失敗しました。") +
      (["brew_not_found", "brew_failed", "brew_no_change"].includes(update.error)
        ? update.brewCommand
        : "")
    : "";
  $("updateStatus").textContent = update.phase ? updatePhaseText[update.phase] : error;
  $("updateStatus").className = `small${update.error && !update.phase ? " error" : ""}`;
  $("updateDetail").hidden = !update.detail;
  $("updateDetail").textContent = update.detail ?? "";
}

const errorText = {
  clipboard_has_no_runtime_key:
    "クリップボードに runtime キー（sk-…）がありません。Platform でキーをコピーしてから実行してください。",
  invalid_tunnelId: "Tunnel ID の形式が違います（tunnel_… ）。",
  busy: "別の処理を実行中です。",
};

$("run").addEventListener("click", async () => {
  $("result").textContent = "実行中…";
  const response = await window.bridge.setup({
    tunnelId: $("tunnelId").value,
    useClipboardKey: $("useClipboardKey").checked,
    replaceRuntimeKey: runtimeKeyStored,
    installTunnelClient: $("installTunnelClient").checked,
    installAgent: $("installAgent").checked,
  });
  if (response.error) $("result").textContent = errorText[response.error] ?? response.error;
  else {
    const errors = response.steps.filter((s) => s.status === "error").length;
    $("result").textContent = errors ? `${errors} 件のエラーがあります。` : "完了しました。";
    $("tunnelId").value = "";
    $("useClipboardKey").checked = false;
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
$("checkUpdate").addEventListener("click", async () => render(await window.bridge.checkUpdate()));
$("installUpdate").addEventListener("click", async () =>
  render(await window.bridge.installUpdate()),
);
$("skipUpdate").addEventListener("click", async () => render(await window.bridge.skipUpdate()));
$("releaseNotes").addEventListener("click", () => window.bridge.openReleaseNotes());
$("autoCheck").addEventListener("change", async (event) =>
  render(await window.bridge.setAutoUpdateCheck(event.target.checked)),
);
$("openAtLogin").addEventListener("change", async (event) =>
  render(await window.bridge.setOpenAtLogin(event.target.checked)),
);
for (const button of document.querySelectorAll("[data-open]"))
  button.addEventListener("click", () => window.bridge.open(button.dataset.open));

window.bridge.onState(render);
void window.bridge.state().then(render);

// Clicking a screenshot shows it full size; clicking again or Esc closes it.
const zoom = document.createElement("dialog");
zoom.className = "zoom";
const zoomed = document.createElement("img");
zoom.append(zoomed);
document.body.append(zoom);
zoom.addEventListener("click", () => zoom.close());
for (const img of document.querySelectorAll("figure img"))
  img.addEventListener("click", () => {
    zoomed.src = img.src;
    zoomed.alt = img.alt;
    zoom.showModal();
  });
