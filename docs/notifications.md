# 自動通知（ターン終了・入力待ち）

Orca のエージェントのターン終了や入力待ちを、dot に知らせる仕組みです。Orca の experimental plugin [orca-agent-status-relay](https://github.com/andoshin11/orca-agent-status-relay) を使います。

```text
Orca ── relay plugin ──▶ 通知サービス（この Mac、常駐）◀── 通知用 Tunnel ◀── ChatGPT（MCP Events）── dot
                                    └──────── 通知（HTTPS webhook）────────▶ ChatGPT
```

- **通知サービス:** LaunchAgent `dev.orca-dots-bridge.notifications` として常駐し、`127.0.0.1:8787`（MCP Events）と `127.0.0.1:8788`（relay plugin の受け口）だけで待ち受けます。
- **通知用 Tunnel:** LaunchAgent `dev.orca-dots-bridge.notification-tunnel` として常駐し、ChatGPT からの購読を通知サービスへ転送します。通知サービスが待ち受けを始めてから起動します。
- **購読:** dot に頼むと、ChatGPT が購読を申し込みます。購読は最大 16 件で、ChatGPT が期限（最長 1 日）の前に自動で更新します。購読は保存されるので、通知サービスや Mac を再起動しても続きます（ペインが同じままの場合）。
- **許可:** Orca Status プラグインの設定「**通知を受け取る**」がオンのときだけ購読を受け付け、通知を送ります。既定はオフです。オフにすると 30 秒以内に購読をすべて止めます。オンにする操作は、プラグイン管理画面からだけ受け付けます。

## 準備（初回だけ）

1. **Orca に relay plugin を入れます。** 手順は[relay plugin による通知](relay-notifications.md)の「1. relay plugin を入れる」です。plugin の設定は `setup` が作ります。
2. **Platform で通知用の Tunnel を作ります。** 状態確認用とは別の Tunnel にし、個人の ChatGPT workspace に関連付けます。
3. **この Mac を準備します。** メニューバーアプリでは、「通知用の Tunnel も使う」に 2 の ID を入れ、「通知サービスと通知用の Tunnel を常駐させる」をオンにして「セットアップを実行」を押します。CLI では次のとおりです。

   ```sh
   node dist/setup.mjs --notification-tunnel-id '<2 の Tunnel ID>' --install-notifications
   ```

4. **ChatGPT に通知用のプラグインを作ります。** 状態確認用と同じく「カスタム MCP サーバーを追加」で、接続タイプ「トンネル」で 2 の Tunnel を選び、認証は「認証なし」にします（Tunnel 接続は runtime キーと、Tunnel が付ける Bearer で守られます）。
5. **Orca Status の設定で「通知を受け取る」をオンにします。** 設定欄に出ない場合は、Orca Status の管理画面で「ツールを更新」を押してから開き直してください。

## 使う

dot に「Orca の ○○ の作業が終わったら教えて」のように頼みます。購読の引数は、`orca_status` が返すエージェントの terminal handle と作業ツリー ID（`terminalHandle`・`worktreeId`）です。通知サービスはその端末の現在のペインを確かめてから購読を受け付けます。

dot は、依頼が本人からかを確かめるために、購読の前に確認を求めることがあります。

## 状態の確認

| 確認すること                               | 方法                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通知サービスと通知用 Tunnel が動いているか | `node dist/setup.mjs doctor`（`notification-service`・`notification-tunnel`）、またはメニューバーアプリ                                                                             |
| 購読や通知の流れ                           | `~/.orca-dots-bridge/notifications/counts.json` の件数（`method_subscribe`、`subscription_created`、`relay_status_received`、`pane_status_queued` など）。秘密や URL は記録しません |
| 購読が送り先のホストで拒否されていないか   | `~/.orca-dots-bridge/notifications/rejected-callback-host`                                                                                                                          |

ChatGPT が通知を送る先（callback）のホストは、既定で `connectors.api.openai.com` だけを許可しています。別のホストで購読が拒否された場合は、そのホスト名が `rejected-callback-host` に記録されます。内容を確かめたうえで、`~/.orca-dots-bridge/settings.json` の `notificationCallbackHosts`（配列）に足し、通知サービスを再起動してください（`launchctl kickstart -k gui/$(id -u)/dev.orca-dots-bridge.notifications`）。

## 制約

- **ペイン単位です。** 同じペインで始まった別のエージェントのセッションは区別しません。relay plugin が止まっても気づけず、取りこぼしも検出できません（[relay plugin による通知](relay-notifications.md)）。
- **ペインが変わると購読は終わります。** Orca を再起動して端末の handle やペインが変わった場合、その購読は止まり、ChatGPT の次の更新で失敗します。dot にもう一度頼んでください。
- **通知の受け取り方は ChatGPT 次第です。** 通知が ChatGPT に受理されても、dot がどう表示・発話するかは保証できません。
- **ChatGPT の Work チャットでは購読できませんでした。** 2026年10月の時点で、Work チャットに購読を頼むと「この環境には指定プラグインのイベント購読機能が公開されていない」と返されました。dot からは購読の手前（本人確認）まで進むことを確かめています。

## 試験用の入口

以前の、1 対象・承認から 10 分で止まる試験用の入口（`dist/notification-two-phase.mjs` など）も残しています。手順は[通知用 Tunnel の設定](notification-tunnel.md)と[relay plugin による通知](relay-notifications.md)を参照してください。常駐版の通知サービスと同時には動かせません（同じポートを使うため）。
