# CLI で使う

Orca CLI を bridge 経由で呼び、状態の確認と1端末への追加指示を行う手順とリファレンスです。dot・ChatGPT から使う場合は[ChatGPT（dot）から使う](chatgpt-tunnel.md)を参照してください。

手順1〜3で、この Mac の Orca の状態を1回読めるところまで進めます。必要なら4で指示送信、5で MCP 対応のアシスタントへ接続します。コマンドはこれから使う Mac の「ターミナル」で上から順に実行してください。Orca と bridge は同じ Mac・同じログインユーザーで動かします（Orca 1.4.224 で確認しています）。

## 1. 必要なものを用意する

- **Git**：`git --version`で確認します。未導入なら[GitのmacOS向け案内](https://git-scm.com/download/mac)に従って導入してください。
- **Node.jsとnpm**：[Node.js公式配布](https://nodejs.org/en/download)からNode **24.x（24.11.0以上）**と同梱npmを導入します。導入後にターミナルを開き直し、`node --version`と`npm --version`で確認してください。対応Nodeの全範囲は下の開発用コマンド欄に記載しています。
- **Orcaアプリと付属CLI**：[Orca公式インストール案内](https://www.onorca.dev/docs/install)から、このMacに合うApple Silicon / Intel版を導入して起動します。アプリのSettingsで「Orca CLI」を探し、CLIを登録してください。[公式CLI案内](https://www.onorca.dev/docs/cli/overview)ではGeneral内、別の参照ページではExperimental内と記載されています。表示は版によって確認してください。

基本の読み取りは**Orca 1.4.220**で実測済みです。通常版のCLIを使い、通知試験用の改造は不要です。別バージョンの互換性は保証していません。旧版の配布先はOrca公式インストール案内の「Older versions」から確認できます。指示送信には、接続・書込み可否・agent識別情報を返す対応CLI/runtimeが必要です。

Orcaの初期設定を済ませ、確認したいリポジトリと作業をアプリで開いたまま、次を実行します。

```sh
command -v orca
export ORCA_ENVIRONMENT=''
export ORCA_PAIRING_CODE=''
orca status --json
```

1行目にCLIのパスが表示され、最後のコマンドでruntimeの状態がエラーなく返れば次へ進めます。環境変数を空にするのは、このターミナルでローカルのOrcaを選ぶためです。CLIが見つからない場合は先に登録を確認してください。bridgeはOrcaを自動起動しません。

## 2. bridgeを取得する

いちばん簡単なのは、[GitHub Releases](https://github.com/andoshin11/orca-dots-bridge/releases/latest) の`orca-dots-bridge-<版>.tar.gz`を展開する方法です。依存は同梱済みで、`npm ci`やbuildは要りません（Node.js 22以上は必要です）。

```sh
tar xzf orca-dots-bridge-<版>.tar.gz
cd orca-dots-bridge-<版>
node dist/cli.mjs --help
```

ソースから作る場合は次のとおりです。保存先の例はホーム内の`Developer`です。既に同名フォルダがある場合は重ねてcloneせず、そのcheckoutの状態を確認してください。

```sh
mkdir -p "$HOME/Developer"
cd "$HOME/Developer"
git clone https://github.com/andoshin11/orca-dots-bridge.git
cd orca-dots-bridge
npm ci --ignore-scripts
npm run build
node dist/cli.mjs --help
```

各コマンドが成功してから次へ進んでください。最後に`status|overview|waiting|detail|logs|inspect|send`の使い方が表示されればbuild完了です。`npm ci`は同梱lockfileの依存を導入します。APIキーや`.env`ファイルは、この基本手順には不要です。

## 3. 最初の状態確認をする

引き続きbridgeのフォルダ内で実行します。`ORCA_BIN`は手順1で登録したOrca CLIの場所です。

```sh
export ORCA_BIN="$(command -v orca)"
node dist/cli.mjs overview --limit 5
```

**`"ok": true`と`result.items`が返れば基本接続は成功です。** `items: []`は取得範囲に作業がない状態です。Orcaで作業を開いてから再実行してください。作業名が分かったら、次の例の2つの値を`items`の`repo`・`title`に置き換えて個別確認できます。長い名前は省略表示されるため、その場合はOrca上の正式名を使います。

```sh
node dist/cli.mjs status --repo 'my-project' --name 'my-task'
```

CLIは結果を表示して終了します。常駐サーバーを起動し続ける必要はありません。より詳しい読み取り検証は[ローカル検証手順](local-validation.md)へ進んでください。出力には作業情報が含まれるので、公開repoへ保存しないでください。

## 4. 追加指示を送りたいときだけ

まず`overview`の`items[].id`をコピーして対象の端末を確認します。`<...>`は説明用の値なので、実際の結果に置き換えてください。

```sh
node dist/cli.mjs detail --id '<items[].id>'
```

`result.terminals`から意図したagentの`handle`と`worktreeId`を確認します。**次のコマンドは実際に指示を送ります。** 対象と本文を確認したときだけ実行してください。

```sh
node dist/cli.mjs send --handle '<terminal.handle>' --expected-worktree-id '<terminal.worktreeId>' --text '現在の進捗を短く教えてください'
```

`accepted`は入力の受付であり、作業完了ではありません。タイムアウトなどで結果不明なら自動再送しません。詳しい制約は下の「1端末への追加指示」を参照してください。

## 5. アシスタントから使う（任意）

**ローカルのMCP対応クライアント**には、クライアントのMCP設定画面で次のstdioサーバーを登録します。まずbridgeのフォルダで必要な絶対パスを確認してください。

```sh
node -p 'process.execPath'
pwd
command -v orca
```

以下は設定例です。`command`を1行目の出力、`args`内を2行目の出力に`/dist/mcp.mjs`を付けたパス、`ORCA_BIN`を3行目の出力に置き換えます。クライアントによって設定形式は異なります。Codex用には[既存設定例](../examples/codex-mcp.toml)があります。

```json
{
  "mcpServers": {
    "orca-readonly": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/orca-dots-bridge/dist/mcp.mjs"],
      "env": {
        "ORCA_BIN": "/absolute/path/to/orca",
        "ORCA_ENVIRONMENT": "",
        "ORCA_PAIRING_CODE": "",
        "ORCA_BRIDGE_ENABLE_SEND": "0",
        "ORCA_BRIDGE_STATUS_ONLY": "0",
        "ORCA_BRIDGE_TOOLSET": "full"
      }
    }
  }
}
```

クライアントがbridgeを起動します。ツール一覧に`orca_overview`など読み取り6ツールが表示され、`orca_overview`を呼ぶと状態が返ることを確認してください。MCPからも指示を送る場合だけ、`ORCA_BRIDGE_ENABLE_SEND`を`"1"`に変えて再接続します。追加される`orca_send_instruction`は変更操作です。なお、この設定はMCPの制限であり、手順4のCLI送信には不要です。

起動コマンド自体は`node dist/mcp.mjs`です。手動実行時に何も表示されず待つのはstdio通信待ちであり、ブラウザーで開くURLはありません。通常は手動で別起動せず、MCPクライアントに起動させます。

**クラウドのdot**はこのローカル設定を自動で引き継ぎません。接続済みコンピューターのローカルタスク経由なら[dotからの呼び出し](local-validation.md#dotからの呼び出し)、直接MCP接続なら[ChatGPT（dot）から使う](chatgpt-tunnel.md)の`setup`コマンドで準備できます（手作業で組む場合は下の「Secure MCP Tunnelでstatusだけを公開する（手作業）」）。

## 読み取り CLI

```sh
# 指定タスクの進捗を1回で取得（完全一致）
node dist/cli.mjs status --repo '<repo>' --name '<task name>' --branch '<branch>'

# 概要。id は返された値をそのまま利用
node dist/cli.mjs overview --limit 5
node dist/cli.mjs overview --limit 5 --cursor '<nextCursor>'

# 判断待ち・注意が必要な状態の探索（1ページ当たりの調査件数）
node dist/cli.mjs waiting --limit 10
node dist/cli.mjs waiting --limit 10 --cursor '<nextCursor>'

# 個別ワークツリー。端末 handle もここで取得
node dist/cli.mjs detail --id '<overview.items[].id>'

# 最大40行、8000文字（既定値）
node dist/cli.mjs logs --handle '<terminals[].handle>'
node dist/cli.mjs logs --handle '<handle>' --limit 20 --max-chars 4000 --cursor '<nextCursor>'
```

正常時は `{ "ok": true, "result": ... }`、失敗時は `{ "ok": false, "error": { "code", "message" } }` と終了コード1を返します。エラーにはraw stderrやOrcaのエラー本文を含めません。成功時のタスク・ログ出力には機密情報が含まれ得るため、出力をコミットしないでください。`ORCA_BIN=/absolute/path/to/orca` で実行ファイルを指定できます。実行ファイル指定は運用者の信頼済み設定であり、MCP引数から変更できません。

## 名前を指定して素早く確認

`status` / `orca_status` は一覧を新しく取得し、repoとnameの完全一致で状態を集計します。同名候補はbranch・hostId・idで絞ります。候補が曖昧なら端末を選びません。チーム端末が一意なら、その候補の短いログと待機情報を並列取得します。親情報の欠落だけではmainと判定しません。最大12agentの要約と12行・1600文字のログを返し、待機未評価件数を明示します。

呼び出し側はこの結果を受け取ったら短く回答してタスクを終了してください。[即時応答の呼び出し手順と計測範囲](quick-status.md)を参照してください。

## 特定済み端末を素早く確認

対象handleが既知なら、全体の再探索をせずに `inspect` を使えます。端末メタデータと上限付きログを並列に読み、1回のCLI/MCP呼び出しで返します。キャッシュは使いません。

```sh
node dist/cli.mjs inspect --handle '<terminal handle>' --expected-worktree-id '<known worktree id>' --limit 20 --max-chars 2000
```

MCPでは `orca_terminal_inspect` に同じ引数（expectedWorktreeIdは任意）を渡します。ワークツリー一致に失敗したら再探索してください。結果はscope=single_terminalで、ワークツリー内の全agent状態やfleet集計は含みません。全体確認はoverview/detail、特定済みセッションの追跡はinspectと使い分けます。並列取得は同一時点の原子的なsnapshotではありません。

## 1端末への追加指示

ユーザーが指定した対象と本文がある場合だけ実行してください。detailで返された正確なterminal handleを使います。ワークツリーID・paneKey・current・allは送信対象として受け付けません。

```sh
node dist/cli.mjs send --handle '<terminal handle>' --text '追加で確認してほしい内容'
```

- 本文は非空、最大16000 UTF-8バイトかつ16000 UTF-16文字。空白のみ、制御文字（改行・タブ以外）、先頭が `--` の本文、未知の追加引数は拒否します。CLIのシェル上では本文を適切に引用してください。
- 直前に同じhandleをshowで読み、connected・writable・agentIdentityが確認できた対象だけに送ります。旧ホストでこれらを検証できない場合も送信しません。
- 呼び出しは `terminal send --terminal <handle> --text <text> --enter` の1回のみ。shellを使わず本文を1引数として渡します。interrupt・retry・bulkオプションはありません。
- `accepted` / `delivery` は入力受付・拒否、`turnStarted` はOrcaがターン開始を観測したかを示します。**どちらもタスクの完了ではなく、completionは常にnot_observedです。** 受付拒否も構造化結果として返ります。
- 送信後のタイムアウト・切断・不正なreceiptは `send_outcome_unknown` です。受付済みの可能性があるため、自動で再送しないでください。retrySafeはfalseです。startedAt・observedAt・timingsMsで事前確認と受付までの時間を区別します。notificationDelivery=outside_bridgeは、会話への結果通知がブリッジ外の処理であることを表します。本文は結果に含めませんが、CLIプロセスの引数としてOSから見えるため秘密情報を本文に入れないでください。
- preflightと送信は単一トランザクションではありません。実行時のagentへの配送判定はOrcaに委ねます。返された観測がunsupportedならターン開始を保証しません。

呼び出し側は送信を短い単独タスクとして実行し、receiptを得たら直ちに受付結果を返してそのタスクを終了してください。性能調査・ログ追加取得・相手の完了待ちを同じ返信の前に続けないでください。CLIが返した時刻と、dot/音声へ通知できた時刻は別です。後続作業は受付結果を伝えた後の別依頼として行います。これはタスクの結果通知待ちによる遅れを減らす呼び出し方で、ブリッジが音声通知したことを保証するものではありません。

MCPで送信も利用する場合のみ、サーバー起動環境に `ORCA_BRIDGE_ENABLE_SEND=1` を設定します。追加される `orca_send_instruction` はreadOnlyHint=false、idempotentHint=falseの変更ツールです。クライアントのenabled_toolsを使う場合は同名も追加してください。既定の設定例は読み取り6ツールだけを許可します。

```sh
ORCA_BRIDGE_ENABLE_SEND=1 node dist/mcp.mjs
```

送信は公式CLI契約と合成fixtureによるテストで検証しています。**実エージェントへの試験送信は行っていません。** 読み取り用のverify:localもsendを呼びません。

## ローカルruntimeと任意のリモート接続

Orca 1.4.220のローカルruntimeで、CLIとMCP SDKクライアントから4機能の実読み取りを検証しています。実測の時刻・件数・端末情報はリポジトリに含めません。同じコンピューター上で利用する場合、リモートpairingは不要です。

再検証は `npm run verify:local`。このコマンドだけは実Orcaを読みます。ORCA_ENVIRONMENT / ORCA_PAIRING_CODEを子プロセス内で空にしてローカルを選び、結果には時刻・件数・所要時間だけを出し、タスク本文・ログ本文は残しません。通常の `npm test` / `npm run verify` は実Orcaを呼びません。

任意のリモートruntimeがすでにペアリング済みなら、クライアント側で保存済みenvironment名を指定できます。

```sh
ORCA_ENVIRONMENT='<saved-environment-name>' node dist/cli.mjs overview --limit 5
```

同じ環境変数をMCPホストの設定にも渡します。Orca標準の `ORCA_PAIRING_CODE` は継承されますが、このブリッジは発行・保存しません。pairing codeをリポジトリに書かないでください。未接続なら、人がOrca側で接続先・認証方式を決めてpairingを完了させる必要があります。接続したruntimeの `hostScope` 外のホストまで観測できるとは扱いません。

## 件数・鮮度・状態の意味

- 単位は **Orcaワークツリーとそのagent/pane** です。ExperimentalなOrchestrationのtask/gate/mailboxは扱いません。ワークツリー1件に複数agentがあり得ます。
- `worktree ps` / `terminal list` に各1001件を要求し、最大1000件を使います。上限到達・上流truncatedは `inventoryIncomplete` に示します。上限外の項目はページングでも取得できません。
- overview の `agentCounts` は取得済みinventory全体の観測state集計です。全ホストや実際の作業完了を保証する数値ではありません。
- ページは既定20、最大50件です。ID順に並べ、inventoryの構成が変わると `cursor_expired` を返します。カーソルは次のCLI起動でも利用できます。状態は毎回再取得され、固定時点のスナップショットではありません。
- waiting のlimitは**探索件数**です。terminal showを最大4並列で実行し、明示された `agentWait.reason/since/source` とagentのblocked/waitingを返します。blocked/waitingは注意が必要な観測であり、人間の承認待ちとは限りません。欠けたagentWaitとnullを区別し、show失敗と未評価件数も返します。
- detail は最大20agent・20terminal。省略時はそれぞれtruncatedフラグを返します。初期版ではこの上限を超える詳細のページングは未対応です。
- `fetchedAt` は取得時刻、`updatedAt` はagentの状態更新時刻、`lastOutputAt` は端末出力時刻です。5分以上古い観測を `old_observation` としますが、**無出力や古い観測だけでstuck・停止・完了とは判定しません**。host-owned、restored-unconfirmedも区別します。未知のstateはunknownと元のstateを返します。
- ログは最大200行・20000 UTF-16文字、既定40行・8000文字。ローカル省略があれば `outputClipped` と `cursorAdvancesPastOmittedText` を返します。その場合nextCursorは省略部分の後を指すため、完全なログ取得には使えません。上流 `truncated/limited` も保持します。
- Orca 1.4.220の実測では `terminal read` が `source: screen` を返しました。`cursorUsableForHistory` がtrue（stream）の場合だけ履歴の差分取得として利用してください。screen/unknownは履歴の連続性を保証しません。
- CLI呼び出しは各10秒・8MiBまで。最終JSONは256KiBまで（超過時はresponse_limitとしlimitを減らして再試行）。waiting/detailは複数回の読み取りなので全体では10秒以上かかり得ます。自動再試行・runtime自動起動・永続キャッシュはありません。
- `hostCoverageVerified` は両一覧のhostScopeが存在し、omittedHostIdsが空であることだけを表します。未登録ホストまで列挙したという意味ではありません。
