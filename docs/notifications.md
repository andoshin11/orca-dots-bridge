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

1. **Orca に relay plugin を入れます。** Orca の Settings → Plugins → プラグインをインストール → Git URL に次を入れ、権限 `events:subscribe` を確認して承認します。plugin の設定（送信先と署名用の鍵）は、3 の `setup` が作ります。

   ```text
   https://github.com/andoshin11/orca-agent-status-relay#v0.1.0
   ```

2. **Platform で通知用の Tunnel を作ります。** 状態確認用とは別の Tunnel にし、個人の ChatGPT workspace に関連付けます。
3. **この Mac を準備します。** メニューバーアプリでは、「通知用の Tunnel も使う」に 2 の ID を入れ、「通知サービスと通知用の Tunnel を常駐させる」をオンにして「セットアップを実行」を押します。CLI では次のとおりです。

   ```sh
   node dist/setup.mjs --notification-tunnel-id '<2 の Tunnel ID>' --install-notifications
   ```

4. **ChatGPT に通知用のプラグインを作ります。** 状態確認用と同じく「カスタム MCP サーバーを追加」で、接続タイプ「トンネル」で 2 の Tunnel を選び、認証は「認証なし」にします（Tunnel 接続は runtime キーと、Tunnel が付ける Bearer で守られます）。
5. **Orca Status の設定で「通知を受け取る」をオンにします。** 設定欄に出ない場合は、Orca Status の管理画面で「ツールを更新」を押してから開き直してください。

## 使う

dot に「Orca の ○○ の作業が終わったら教えて」のように頼みます。購読の引数は、`orca_status` が返すエージェントの terminal handle と作業ツリー ID（`terminalHandle`・`worktreeId`）です。通知サービスはその端末の現在のペインを確かめてから購読を受け付けます。

イベントは種類ごとに分かれています。dot には、届いたイベントの中身（`data`）が見えず、イベント名だけが分かる場合があるためです。

| イベント名                 | 届くとき                                 |
| -------------------------- | ---------------------------------------- |
| `orca.pane_turn_finished`  | エージェントのターンが終わったとき       |
| `orca.pane_input_required` | エージェントが入力や承認を待っているとき |

どちらも、ペインの監視が止まったときは `data.kind` が `monitoring_interrupted` のイベントが届きます。両方を知りたい場合は、両方を購読するよう頼んでください。以前の `orca.pane_activity`（全種類をまとめたイベント）の購読も引き続き届きます。

dot は、依頼が本人からかを確かめるために、購読の前に確認を求めることがあります。

### 通知の中身が dot に見えない場合

2026年10月の時点で、dot には通知が届いたことしか伝わらず、イベント名も中身（`data`）も見えません。dot の側では「Event data is supplied in the following automations.mcp_event tool result」と案内されますが、その結果が届きません。

そのため通知用プラグインに、直近の通知を読む tool `orca_recent_notifications` を用意しています。通知が届いたら、この tool で何が起きたか（イベント名・種類・時刻・端末）を確かめるよう dot に頼んでください。tool はこのサービスのメモリに直近 20 件だけ持ち、通知サービスを再起動すると空になります。「通知を受け取る」がオフのときは何も返しません。

## 状態の確認

| 確認すること                               | 方法                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通知サービスと通知用 Tunnel が動いているか | `node dist/setup.mjs doctor`（`notification-service`・`notification-tunnel`）、またはメニューバーアプリ                                                                             |
| 購読や通知の流れ                           | `~/.orca-dots-bridge/notifications/counts.json` の件数（`method_subscribe`、`subscription_created`、`relay_status_received`、`pane_status_queued` など）。秘密や URL は記録しません |
| 購読が送り先のホストで拒否されていないか   | `~/.orca-dots-bridge/notifications/rejected-callback-host`                                                                                                                          |

ChatGPT が通知を送る先（callback）のホストは、既定で `connectors.api.openai.com` だけを許可しています。別のホストで購読が拒否された場合は、そのホスト名が `rejected-callback-host` に記録されます。内容を確かめたうえで、`~/.orca-dots-bridge/settings.json` の `notificationCallbackHosts`（配列）に足し、通知サービスを再起動してください（`launchctl kickstart -k gui/$(id -u)/dev.orca-dots-bridge.notifications`）。

## 仕組み

### 通知用 Tunnel と認証

MCP Events では、dot が通知サービスに `events/subscribe` を送って購読を作ります。dot（クラウド）から Mac の `127.0.0.1:8787` に届く経路が要るので、自動通知には通知用の Tunnel が必要です（状態確認は、dot のローカルタスク経由なら Tunnel なしでも使えます）。Secure MCP Tunnel のクライアントは Mac から外へ接続するだけで、Mac でポートを開かず、インターネットに公開される URL も作りません。Cloudflare Tunnel や Tailscale Funnel、ポート開放などで購読の入口を公開する方法は、守りが Bearer だけになるので勧めません。状態確認用の Tunnel とは共有しません。

通知サービスは `Authorization: Bearer <API キー>`（Keychain の `service-v1` から作るもの）を要求します。このヘッダーは Tunnel クライアントが付けます。`setup` が `~/.orca-dots-bridge/tunnel/service-authorization` に Bearer の値を書き、通知用のプロファイル（`~/.orca-dots-bridge/tunnel/profiles/orca-notifications.yaml`）の `mcp.extra_headers` から `file:` で参照します。そのため ChatGPT のプラグインは「認証なし」で接続でき、API キーは Mac から出ません。

### relay plugin からの受け取り

- relay の受け口（`127.0.0.1:8788/relay`）は MCP Events 用とは**別の loopback ポート**です。Tunnel が転送する MCP 用のポートからは届きません。ポートは `setup --relay-port` で変えられ、relay plugin の設定にも同じ番号が書かれます。
- 受け口は、Standard Webhooks の署名（Keychain の `relay-v1` と、plugin の設定ファイル `~/.config/orca-agent-status-relay/config.json` に同じ鍵）と時刻（±5 分）を検証し、同じ `webhook-id` の再送を拒否します。再送の記録はプロセス内だけで、通知サービスを再起動すると消えます。
- `done` は `turn_finished`（`outcome: "unconfirmed"`）、`waiting` と `blocked` は `input_required` として送ります。`working` は送りません。
- イベントを受けるたびに `orca terminal show` で対象のペインを読み直します（この Mac のユーザー権限で Orca CLI を使います）。worktree・ペイン・handle・PTY 世代（`incarnationId`）のどれかが購読時と違えば `monitoring_interrupted`（`identity_changed`）を送って監視を止めます。Orca CLI から読めなければ `target_unavailable` で止めます。
- relay plugin が同じ状態を重複して送っても、`eventId`（ペイン・状態・`mainAgent.stateStartedAt` から作る）が同じになるので、dot には 1 回だけ届きます。Orca のイベントに `mainAgent` がない場合は受信時刻で作るため、重複がそのまま届くことがあります。
- 通知サービスがイベントを処理しきれない場合（Orca CLI の応答待ちで 16 件以上たまった、状態の保存に失敗した）は、`monitoring_interrupted`（`queue_limit` / `ingest_failed`）を送って監視を止めます。dot の webhook が受け付けず送信待ちが上限（購読ごとに 16 件）に達している場合は、停止の通知も積めずに失われます。
- この通知サービスが対応しているのは relay plugin v0.1 です。メッセージの形が合わない場合はすべて `400` になり、`counts.json` に `relay_schema_rejected` が記録されます（relay plugin は再送しません）。何も届かないとき（`relay_arrived` が増えないとき）は、plugin の設定のポートを確かめてください。relay plugin の「Agent Status Relay: Send test event」コマンドで疎通を確かめられます。

## 制約

- **ペイン単位です。** 同じペインで始まった別のエージェントのセッションは区別しません（PTY が作り直された場合だけ検出します）。relay plugin が止まっても気づけず、取りこぼしも検出できません。dot へのイベントには `assurance: "pane_only"` が付き、catalog の説明にもこの制約を書いています。
- **ペインが変わると購読は終わります。** Orca を再起動して端末の handle やペインが変わった場合、その購読は止まり、ChatGPT の次の更新で失敗します。dot にもう一度頼んでください。
- **通知の受け取り方は ChatGPT 次第です。** 通知が ChatGPT に受理されても、dot がどう表示・発話するかは保証できません。
- **ChatGPT の Work チャットでは購読できませんでした。** 2026年10月の時点で、Work チャットに購読を頼むと「この環境には指定プラグインのイベント購読機能が公開されていない」と返されました。dot では購読でき、ターン終了と入力待ちの両方の通知が届くことを確かめています（2026-10-11）。
