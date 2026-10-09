# relay plugin による通知（ペイン単位）

通常版の Orca で、ターン終了・入力待ちを dot に通知するための経路です。改造版 Orca の専用 RPC は使いません。代わりに Orca plugin [orca-agent-status-relay](https://github.com/andoshin11/orca-agent-status-relay) がエージェントの状態変化を bridge に送り、bridge がそれを既存の二段階試験の入口から dot に届けます。

```text
Orca ── agent.status.changed ──▶ orca-agent-status-relay（Orca plugin）
                                        │ Standard Webhooks 署名付き POST
                                        ▼
                     bridge の relay 受け口（127.0.0.1:<relayPort>/relay）
                                        │ ペインの同一性を Orca CLI で再確認
                                        ▼
                     既存の二段階試験の入口 ── MCP Events webhook ──▶ dot
```

## 既存のセッション経路との違い

イベント名は `orca.pane_activity` です。既存の `orca.session_activity`（改造版 Orca が必要）とは別の経路で、既存の経路の挙動は変えていません。

| 項目                                       | `orca.session_activity`（既存）                     | `orca.pane_activity`（この経路）                                                 |
| ------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| 必要な Orca                                | 専用 RPC を足した改造版                             | 通常版（1.4.223 で確認）+ relay plugin v0.1                                      |
| 対象の特定                                 | provider session・launch・PTY 世代・authority epoch | worktree・ペイン（`tabId:leafId`）・terminal handle・PTY 世代（`incarnationId`） |
| 同じペインで新しいセッションが始まったとき | 区別できる                                          | **区別できない**（PTY が作り直された場合だけ検出する）                           |
| 取りこぼしの検出                           | 連番で検出し、監視を止める                          | **検出できない**（relay plugin が止まっても bridge は気づかない）                |
| ターン終了の成否                           | `unconfirmed`                                       | `unconfirmed`（同じ）                                                            |

dot へのイベントには `assurance: "pane_only"` が付きます。dot の catalog の説明にも、上の 2 つの制約を書いています。

## 準備

### 1. relay plugin を入れる

Orca の Settings → Plugins → プラグインをインストール → Git URL に次を入れ、権限 `events:subscribe` を確認して承認します。

```text
https://github.com/andoshin11/orca-agent-status-relay#v0.1.0
```

### 2. 試験用の鍵を作る（初回だけ）

bridge のフォルダで、Mac の「ターミナル」から直接、次を実行します。API キーが画面に出るので、Orca の内蔵ターミナル（エージェントが読める）や画面共有中・録画中のターミナルでは実行しないでください。

```sh
npm run build
node dist/trial-key-setup.mjs
```

- macOS Keychain の `orca-dots-bridge.notifications-test` に、`outbox-v1`（試験の送信待ちを暗号化する鍵）と `service-v1`（dot を認証する鍵）を作ります。
- `service-v1` から作った **dot プラグインの API キー**を、ターミナル（stderr）に 1 回だけ表示します。dot 側の設定に入れたら、画面を閉じてください。チャット・Git・コマンド引数・通常ログには貼らないでください。もう一度は表示できないので、控えそびれたら両方の account を消してから作り直します。
- stderr が端末でない（リダイレクトしている）場合は、鍵を作る前に `private_terminal_required` で止まります。
- どちらかの account が既にあれば、何も上書きせずに止まります。途中で失敗した場合は、このコマンドが作った分を消します。Keychain への書き込みが途中で失敗した account も、このコマンドが作ったものとして消します。想定外のエラーで書き込めたか判断できない account や、消せなかった account は消さずに、失敗メッセージに `(check Keychain accounts: ...)` と名前を出します。その account は Keychain アクセスで確認してください。
- 作り直すときは、次で両方を消してから実行してください。`outbox-v1` を作り直すと、それまでの試験の状態ファイルは読めなくなります（試験は終了時に状態を消すので、通常は影響ありません）。

  ```sh
  security delete-generic-password -s orca-dots-bridge.notifications-test -a outbox-v1
  security delete-generic-password -s orca-dots-bridge.notifications-test -a service-v1
  ```

### 3. relay 用の鍵と plugin の設定を作る

bridge のフォルダで、relay を受けるポートを決めて実行します（MCP 用の `port` とは別の番号にします）。

```sh
npm run build
node dist/relay-key-setup.mjs --relay-port 8788
```

- macOS Keychain の `orca-dots-bridge.notifications-test` / `relay-v1` に 32 バイトの鍵を作ります。
- 同じ鍵を `~/.config/orca-agent-status-relay/config.json`（権限 600）に書き、送信先を `http://127.0.0.1:8788/relay` にします。
- 鍵は画面にもコマンド引数にも出しません。Keychain の account と設定ファイルのどちらかが既にあれば、何も上書きせずに止まります。作り直すときは、両方を自分で消してから実行してください。

relay plugin の「Agent Status Relay: Send test event」コマンドで、この段階の疎通を確かめられます（bridge 側の受け口が起動している必要があります）。

### 4. 監視するペインの対象を取る

`detail` などで監視したい terminal の handle を確かめ、次を実行します。

```sh
ORCA_BIN="$(command -v orca)" node dist/cli.mjs pane-target --handle '<terminal handle>'
```

`result.target` が設定の `target` に、`result.targetHash` が承認範囲の `targetHash` に入ります。

### 5. 二段階試験を起動する

既存の二段階試験（`dist/notification-two-phase.mjs`）と同じ手順です。違いは次の 3 点です。

- 設定に `"source": "relay"` と `relayPort` を入れ、`runtime` は入れない
- `target` はペイン単位の対象（手順 4 の出力）
- stdin の最初のレコードには `runtimeToken` を入れない（入れると拒否します）

```json
{
  "config": {
    "source": "relay",
    "directory": "/absolute/path/to/trial-state",
    "target": {
      "executionHostId": "local",
      "worktreeId": "...",
      "terminalHandle": "term_...",
      "paneKey": "<tabId>:<leafId>",
      "incarnationId": "..."
    },
    "relayPort": 8788,
    "port": 8787,
    "verificationScope": {
      "host": "<callback host>",
      "owner": "service:trial-service-v1",
      "targetHash": "<pane-target の targetHash>",
      "expiresAt": 0,
      "domainConfirmation": "送信先ドメインを確認 <callback host>",
      "confirmation": "確認通信1回のみを承認 <callback host>",
      "accountBasis": "bounded_protocol_test"
    }
  }
}
```

実際には 1 行の JSON として渡します。`expiresAt` は起動時刻から 10 分以内です。その後の確認通信・private TTY での URL 確認・`activate` レコードは、既存の手順（[Mac mini への移行手順](mac-mini-migration.md) の 4）と同じです。dot から購読入口に届く経路（通知用の Tunnel）の設定は、[通知用 Tunnel の設定](notification-tunnel.md)を参照してください。dot 側の購読ではイベント名 `orca.pane_activity` と、手順 4 の `target` をそのまま使います。手順 2 で表示した API キーは、通知用 Tunnel の設定で Bearer ヘッダーとして使います。

## 動き

- relay の受け口は MCP 用とは**別の loopback ポート**で待ち受けます。Tunnel が転送する MCP 用ポートからは届きません。
- 受け口は、署名（Standard Webhooks）と時刻（±5 分）を検証し、同じ `webhook-id` の再送を拒否します。
- `done` は `turn_finished`（`outcome: "unconfirmed"`）、`waiting` と `blocked` は `input_required` として送ります。`working` は送りません。
- イベントを受けるたびに `orca terminal show` で対象のペインを読み直します。worktree・ペイン・handle・`incarnationId` のどれかが承認時と違えば、`monitoring_interrupted`（`identity_changed`）を送って監視を止めます。Orca CLI から読めなければ `target_unavailable` で止めます。
- 同じ状態を relay plugin が重複して送っても、`eventId`（ペイン・状態・`mainAgent.stateStartedAt` から作る）が同じになるので、dot には 1 回だけ届きます。Orca のイベントに `mainAgent` がない場合は受信時刻で作るため、重複がそのまま届くことがあります。
- bridge 自身がイベントを処理しきれない場合（Orca CLI の応答待ちで 16 件以上たまった、状態の保存に失敗した）は、`monitoring_interrupted`（`queue_limit` / `ingest_failed`）を送って監視を止めます。ただし、dot の webhook が受け付けず送信待ちが上限（購読ごとに 16 件）に達している場合は、停止の通知も積めずに失われます（届け先が受け付けていない状態なので、積めても届きません）。どの場合も、診断には `monitoring_stopped` が記録されます。
- 試験の期限（最長 10 分）・1 対象・承認の流れ・送信先ホストの制限は、既存の経路と同じです。

## 注意点

- **ペインの確認には、この Mac のユーザー権限で Orca CLI を使います。** セッション経路が runtime token だけで runtime に接続するのに対し、この経路は `ORCA_BIN` の Orca CLI（`terminal show`）をそのまま呼びます。
- **relay plugin の設定のポートと、試験設定の `relayPort` は同じにしてください。** 違っていると何も届かず、診断に `relay_arrived` が 1 件も記録されません。
- **relay plugin とメッセージの形が合わない場合は受け付けません。** relay plugin が将来フィールドを足すなどして形が変わると、すべて `400` になり、診断に `relay_schema_rejected` が記録されます（relay plugin は再送しません）。この bridge が対応しているのは relay plugin v0.1 です。
- **再送攻撃の防止はプロセス内の記録です。** 同じ `webhook-id` は 5 分間拒否しますが、bridge を再起動すると記録は消えます（再起動前の時刻のイベントは購読の開始時刻より古いので、dot には届きません）。
- **`relay-v1` の鍵は試験の後も残ります。** 試験の鍵を消す処理（`deleteTrialKeys`）は `service-v1` と `outbox-v1` だけを消します。relay の鍵は plugin の設定ファイルと対になっているので、消す場合は両方を手で消してください。

## 検証の状況（2026-10-10）

- 合成テスト: 受け口の署名・時刻・再送・形式の検証、ペインの再確認、イベントの変換、二段階承認の通し、処理しきれない場合の停止通知（webhook が受け付けている場合）を、テストで確認しています。
- relay plugin v0.1.0（タグ `v0.1.0`、コミット `5f80681`）の実コードから、この bridge の受け口へ送れることを手元で確認しています（署名とメッセージの形の互換性）。
- `pane-target` が Orca 1.4.223 の `terminal show` から対象を作り、その `paneKey` が relay plugin の送るものと一致することを、実機で確認しています。
- **dot への実際の通知（Tunnel・製品側 webhook・音声）は未確認です。**
