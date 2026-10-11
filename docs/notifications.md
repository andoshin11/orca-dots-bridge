# 自動通知（ターン終了・入力待ち）

Orca のエージェントのターン終了や入力待ちを、dot に知らせる仕組みです。Orca の experimental plugin **Agent Status Relay**（[orca-plugins](https://github.com/andoshin11/orca-plugins) から入れます）を使います。

```text
Orca ── Agent Status Relay ──▶ bridge サービス（この Mac、常駐）◀── Tunnel ◀── ChatGPT（MCP Events）── dot
                                        └──────── 通知（HTTPS webhook）────────▶ ChatGPT
```

- **bridge サービス:** 状態確認・指示の送信と同じ、常駐の bridge サービス（LaunchAgent `dev.orca-dots-bridge.service`）が通知も受け持ちます。`127.0.0.1:8787`（MCP。ツールと MCP Events）と `127.0.0.1:8788`（relay plugin の受け口）だけで待ち受けます。
- **Tunnel とプラグイン:** 状態確認と同じ 1 つの Tunnel（LaunchAgent `dev.orca-dots-bridge.tunnel`）と、1 つの ChatGPT プラグインを使います。通知のための Tunnel やプラグインは要りません。
- **購読:** dot に頼むと、ChatGPT が購読を申し込みます。購読は最大 16 件で、ChatGPT が期限（最長 1 日）の前に自動で更新します。購読は保存されるので、bridge サービスや Mac を再起動しても続きます（ペインが同じままの場合）。
- **許可:** プラグインの設定「**通知を受け取る**」がオンのときだけ購読を受け付け、通知を送ります。既定はオフです。オフにすると 30 秒以内に購読をすべて止めます。オンにする操作は、プラグイン管理画面からだけ受け付けます。

## 準備（初回だけ）

[README の使い方](../README.md#使い方)で Tunnel・bridge サービス・ChatGPT のプラグインを準備したあと、次の 2 つを行います。

1. **Orca に Agent Status Relay を入れます。** Orca の「設定」→「プラグイン」→「ソースを管理」で、Git のソースとして次の URL を追加します（ref は `main`）。一覧に出る **Agent Status Relay** をインストールし、「プラグインを有効にする」を押します（権限は `events:subscribe` です）。plugin の設定（送信先と署名用の鍵）は `setup` が作ってあります。

   ```text
   https://github.com/andoshin11/orca-plugins
   ```

2. **プラグインの設定で「通知を受け取る」をオンにします。** 設定欄に出ない場合は、プラグインの管理画面で「ツールを更新」を押してから開き直してください。

以前の構成（通知用の Tunnel とプラグインを別に作っていた場合）から移るときは、[README の「以前の 2 つの Tunnel の構成から移る」](../README.md#以前の-2-つの-tunnel-の構成から移る)を参照してください。通知用のプラグインを消すとその購読も使えなくなるので、dot に購読をもう一度頼んでください。

## 使う

dot に「Orca の ○○ の作業が終わったら教えて」のように頼みます。正確な名前や ID は不要です。dot が `orca_find`（または `orca_status`）で対象のエージェントを探し、その terminal handle と作業ツリー ID（`terminalHandle`・`worktreeId`）を購読の引数に使います。候補が複数あるときは、dot がどれかを確かめます。bridge サービスはその端末の現在のペインを確かめてから購読を受け付けます。

イベントは種類ごとに分かれています。dot には、届いたイベントの中身（`data`）が見えず、イベント名だけが分かる場合があるためです。

| イベント名                 | 届くとき                                 |
| -------------------------- | ---------------------------------------- |
| `orca.pane_turn_finished`  | エージェントのターンが終わったとき       |
| `orca.pane_input_required` | エージェントが入力や承認を待っているとき |

どちらも、ペインの監視が止まったときは `data.kind` が `monitoring_interrupted` のイベントが届きます。両方を知りたい場合は、両方を購読するよう頼んでください。以前の `orca.pane_activity`（全種類をまとめたイベント）の購読も引き続き届きます。

dot は、依頼が本人からかを確かめるために、購読の前に確認を求めることがあります。

### まとめて購読する（全体・リポジトリ・ワークスペース）

「全部のエージェントの入力待ちを教えて」「このリポジトリの作業が終わったら全部教えて」のように頼むと、ペインごとではなく、範囲（scope）を指定した 1 つの購読を作ります。購読の引数は次のどれかです。

| 引数                                      | 対象                                                       |
| ----------------------------------------- | ---------------------------------------------------------- |
| `{terminalHandle, worktreeId}`            | 1 つのペイン（従来どおり）                                 |
| `{scope: "all"}`                          | この Mac のすべてのペイン                                  |
| `{scope: "repo", repo: "<リポジトリ名>"}` | 1 つのリポジトリのすべてのワークスペース（名前は完全一致） |
| `{scope: "worktree", worktreeId: "<ID>"}` | 1 つのワークスペースのすべてのペイン                       |

- **あとから作ったペインやワークスペースも含みます。** どのペインが範囲に入るかは、イベントが届くたびに決めます。relay plugin からの状態に付いている作業ツリー ID（無い場合はペインのキー）から、`orca worktree ps` と `orca terminal list` の一覧でリポジトリ名・ワークスペース名・terminal handle を調べます。一覧は最大 10 秒キャッシュし、見つからないペインがあれば（0.5 秒以上たっていれば）1 回だけ読み直します。relay の受け口はこの読み取りを待たずにすぐ応答します。
- **どのペインかはイベントに付きます。** 範囲の購読で届くイベントの `data.pane` に、`worktreeId`、分かれば `terminalHandle`・`repo`・`workspace` が入ります。`orca_recent_notifications` も同じ項目と、`summary`・`pending` を返します。
- **購読時に名前を確かめます。** `repo` と `worktreeId` は、購読のときに Orca の一覧にあるかを確かめ、無ければ断ります（聞き間違えた名前で、何も届かない購読ができないようにするため）。
- **同じ通知を 2 回送りません。** 同じ相手（同じ callback）・同じイベント名で、1 つのペインの購読と範囲の購読が重なる場合は、ペインの購読だけが届けます。範囲の購読同士が重なる場合は、狭いほう（ワークスペース → リポジトリ → 全体）の 1 つだけが届けます。重なる側の監視が止まっている場合は、残りの購読が届けます。
- 再起動後の再開、「通知を受け取る」をオフにしたときの停止、購読の上限（16 件）はペインの購読と同じです。範囲の購読は、処理待ちが 32 件を超えると `monitoring_interrupted`（`queue_limit`）を送って止まり、ChatGPT の次の更新で再開します。
- 範囲の購読は `orca.pane_turn_finished` と `orca.pane_input_required` だけで使えます（以前の `orca.pane_activity` では使えません）。

### 呼び名（エイリアス）

ワークスペースの名前が音声で通じにくいときは、呼び名を付けられます（例:「debug-birdge を『でばっぐ』って呼んで」）。dot が `orca_set_alias` で登録し、以後は `orca_find` と `orca_brief` が呼び名でも見つけ、結果の `alias` に表示します。通知を頼むときも「でばっぐの作業が終わったら教えて」で通じます。呼び名は `~/.orca-dots-bridge/aliases.json`（権限 600、最大 50 件、1 件 40 文字まで）に保存するだけで Orca には何も送りません。

### 通知の中身が dot に見えない場合

2026年10月の時点で、dot には通知が届いたことしか伝わらず、イベント名も中身（`data`）も見えません。dot の側では「Event data is supplied in the following automations.mcp_event tool result」と案内されますが、その結果が届きません。

そのためプラグインに、直近の通知を読む tool `orca_recent_notifications` を用意しています。通知が届いたら、この tool で何が起きたか（イベント名・種類・時刻・端末）を確かめるよう dot に頼んでください。

通知を送ったあと、bridge サービスはそのペインのエージェントの状態を `orca worktree ps` で1回だけ読み（最大 3 秒。失敗しても通知には影響しません）、次の項目を付けて覚えておきます。dot はこれをそのまま読み上げられます。

| 項目      | 中身                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary` | エージェントの直前の発言（最大 280 文字）                                                                                                                                                                                                                                                                                                                         |
| `pending` | `input_required` のときだけ。何を待っているか（`kind`: permission・question など、`toolName`、実行しようとしているコマンドやファイル名）。端末の画面は読まず Orca の状態から判断するため、目安です。画面に出ている選択肢が承認（permission）・質問（question）・それ以外の選択メニュー（selection。設定メニューなど）のどれかは `orca_pending_input` で確かめます |

どちらもエージェントが書いた内容で、信頼できないデータとして扱います（dot への指示にはなりません）。入力待ちなら、続けて「何を聞かれてる？」と聞くと dot が `orca_pending_input` で質問と選択肢を読み上げ、「1番で」と答えると `orca_answer` で回答します（「指示の送信を許可」がオンのときだけ）。

tool は bridge サービスのメモリに直近 20 件だけ持ち、bridge サービスを再起動すると空になります。「通知を受け取る」がオフのときは何も返しません。

## 状態の確認

| 確認すること                             | 方法                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bridge サービスと Tunnel が動いているか  | `node dist/setup.mjs doctor`（`service`・`tunnel`）、またはメニューバーアプリ                                                                                                       |
| 購読や通知の流れ                         | `~/.orca-dots-bridge/notifications/counts.json` の件数（`method_subscribe`、`subscription_created`、`relay_status_received`、`pane_status_queued` など）。秘密や URL は記録しません |
| 購読が送り先のホストで拒否されていないか | `~/.orca-dots-bridge/notifications/rejected-callback-host`                                                                                                                          |

ChatGPT が通知を送る先（callback）のホストは、既定で `connectors.api.openai.com` だけを許可しています。別のホストで購読が拒否された場合は、そのホスト名が `rejected-callback-host` に記録されます。内容を確かめたうえで、`~/.orca-dots-bridge/settings.json` の `notificationCallbackHosts`（配列）に足し、bridge サービスを再起動してください（`launchctl kickstart -k gui/$(id -u)/dev.orca-dots-bridge.service`）。

## 仕組み

### Tunnel と認証

MCP Events では、dot が bridge サービスに `events/subscribe` を送って購読を作ります。dot（クラウド）から Mac の `127.0.0.1:8787` に届く経路として、状態確認と同じ 1 つの Tunnel を使います。Secure MCP Tunnel のクライアントは Mac から外へ接続するだけで、Mac でポートを開かず、インターネットに公開される URL も作りません。Cloudflare Tunnel や Tailscale Funnel、ポート開放などで入口を公開する方法は、守りが Bearer だけになるので勧めません。

bridge サービスは `Authorization: Bearer <API キー>`（Keychain の `service-v1` から作るもの）を要求します。このヘッダーは Tunnel クライアントが付けます。`setup` が `~/.orca-dots-bridge/tunnel/service-authorization` に Bearer の値を書き、Tunnel のプロファイル（`~/.orca-dots-bridge/tunnel/profiles/orca-dots-bridge.yaml`）の `mcp.extra_headers` から `file:` で参照します。そのため ChatGPT のプラグインは「認証なし」で接続でき、API キーは Mac から出ません。

### relay plugin からの受け取り

- relay の受け口（`127.0.0.1:8788/relay`）は MCP Events 用とは**別の loopback ポート**です。Tunnel が転送する MCP 用のポートからは届きません。ポートは `setup --relay-port` で変えられ、relay plugin の設定にも同じ番号が書かれます。
- 受け口は、Standard Webhooks の署名（Keychain の `relay-v1` と、plugin の設定ファイル `~/.config/orca-agent-status-relay/config.json` に同じ鍵）と時刻（±5 分）を検証し、同じ `webhook-id` の再送を拒否します。再送の記録はプロセス内だけで、bridge サービスを再起動すると消えます。
- `done` は `turn_finished`（`outcome: "unconfirmed"`）、`waiting` と `blocked` は `input_required` として送ります。`working` は送りません。
- イベントを受けるたびに `orca terminal show` で対象のペインを読み直します（この Mac のユーザー権限で Orca CLI を使います）。worktree・ペイン・handle・PTY 世代（`incarnationId`）のどれかが購読時と違えば `monitoring_interrupted`（`identity_changed`）を送って監視を止めます。Orca CLI から読めなければ `target_unavailable` で止めます。
- relay plugin が同じ状態を重複して送っても、`eventId`（ペイン・状態・`mainAgent.stateStartedAt` から作る）が同じになるので、dot には 1 回だけ届きます。Orca のイベントに `mainAgent` がない場合は受信時刻で作るため、重複がそのまま届くことがあります。
- bridge サービスがイベントを処理しきれない場合（Orca CLI の応答待ちで 16 件以上たまった、状態の保存に失敗した）は、`monitoring_interrupted`（`queue_limit` / `ingest_failed`）を送って監視を止めます。dot の webhook が受け付けず送信待ちが上限（購読ごとに 16 件）に達している場合は、停止の通知も積めずに失われます。
- bridge サービスが対応しているのは relay plugin v0.1 です。メッセージの形が合わない場合はすべて `400` になり、`counts.json` に `relay_schema_rejected` が記録されます（relay plugin は再送しません）。何も届かないとき（`relay_arrived` が増えないとき）は、plugin の設定のポートを確かめてください。relay plugin の「Agent Status Relay: Send test event」コマンドで疎通を確かめられます。

## 制約

- **短い間の同じ通知はまとめます。** エージェントが同じ状態を短い間に2回報告することがあるため、同じペインの同じ種類の通知は、5 秒以内のものを1件にまとめます。

- **ペイン単位の観測です（範囲の購読も同じです）。** 同じペインで始まった別のエージェントのセッションは区別しません（PTY が作り直された場合だけ検出します）。relay plugin が止まっても気づけず、取りこぼしも検出できません。dot へのイベントには `assurance: "pane_only"` が付き、catalog の説明にもこの制約を書いています。
- **範囲の購読は、どのペインかを Orca の一覧で調べます。** Orca CLI が読めないときは、relay の作業ツリー ID だけで判断できる範囲（全体・ワークスペース）は ID だけを付けて届け、リポジトリの範囲は届けません（`counts.json` の `scope_status_unresolved`）。
- **ペインが変わると購読は終わります。** Orca を再起動して端末の handle やペインが変わった場合、その購読は止まり、ChatGPT の次の更新で失敗します。dot にもう一度頼んでください。
- **通知の受け取り方は ChatGPT 次第です。** 通知が ChatGPT に受理されても、dot がどう表示・発話するかは保証できません。
- **ChatGPT の Work チャットでは購読できませんでした。** 2026年10月の時点で、Work チャットに購読を頼むと「この環境には指定プラグインのイベント購読機能が公開されていない」と返されました。dot では購読でき、ターン終了と入力待ちの両方の通知が届くことを確かめています（2026-10-11）。
