# MCP Events互換性調査

2026-10-05時点。対象はユーザーが指定した1セッションのターン終了・入力待ちであり、プロジェクト全体の完了判定ではありません。通知コアは合成実装済み、実イベント取得・購読認証・永続保存先・dot実配送は未接続です。[実装範囲と検証](notifications-design.md)を参照してください。

## 追加調査と実装結果

公式分割SDK `@modelcontextprotocol/server` / `client` **2.3.1**がnpmで公開済みです。既存SDKの未対応は移行可能で、SDK不足を最終blockerとは扱いません。[公式v2移行手順](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html)と[2026-07-28対応手順](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html)に従い、別入口 `dist/mcp2.mjs` を追加しました。公式 `serveStdio` を使い、手製のprotocol adapterは使いません。

新入口は既定でstatusのみ、明示opt-in時はstatus/sendの2ツールです。`ORCA_BRIDGE_STATUS_ONLY=1` はsend設定より優先し、sendにはexpectedWorktreeIdを必須とします。入力は既存serviceの厳密schemaで再検証します。旧 `dist/mcp.mjs` の6読み取りツールと送信動作は維持しています。稼働中Tunnelを新入口へ切り替えていません。

合成テストは新入口にMCP `2026-07-28`をpinしたclientとlegacy clientを接続し、それぞれstatus・send・status-only優先を確認します。対象欠落・不正handle・worktree不一致・禁止本文・余分な引数を拒否し、合成対象だけへの送信receiptを確認しました。新旧合計41テストが通過しました。Events capabilityは広告していません。後続で購読コアを独立ライブラリとして実装しましたが、稼働中の入口には未接続です。

## 現在残る接続条件

- **OrcaイベントAPIは存在するが新規権限が必要。** インストール版に対応する[1.4.220のhost API](https://github.com/stablyai/orca/blob/v1.4.220/src/shared/plugins/plugin-host-api.ts)の `events.subscribe` はexperimental、worker専用、`events:subscribe` capability必須、scopeはhost-eventsです。引数はevent名だけでsession filterを受けません。[event bus](https://github.com/stablyai/orca/blob/v1.4.220/src/main/plugins/plugin-event-bus.ts)もevent名単位です。全セッションを受信してから絞る方式を、指定セッションだけの購読と同一視しません。導入・権限付与・監視開始は未実施です。
- **公開payloadだけではセッション同一性が足りない。** [1.4.220のイベント型](https://github.com/stablyai/orca/blob/v1.4.220/src/shared/plugins/plugin-events.ts)にはworktreeId、paneKey、state、receivedAt、optional mainAgentがありますが、terminal handle・session/run ID・turn ID・host IDはありません。pane再利用時や子agent残存時を含む対応付けを確定する必要があります。状態変化をプロジェクト完了として通知しません。
- **現行stdioから購読所有者を認証する契約が未確立。** Tunnel v0.0.15の[stdio実装](https://github.com/openai/tunnel-client/blob/v0.0.15/pkg/mcpclient/stdio_command.go)はGo SDKのIOTransportへJSON-RPCを渡します。[header carrier](https://github.com/openai/tunnel-client/blob/v0.0.15/pkg/mcpclient/internal/context.go)はHTTP転送用です。この経路から検証済みユーザー識別子をstdioメタデータへ注入する契約は確認できません。任意のclientInfoや引数を認証済み所有者として利用しません。認証付きHTTP upstreamへの変更は候補ですが、認証設定・資格情報・client切替の具体化と承認が必要です。

このため、SDK移行の合成検証は可能ですが、現在の承認範囲で実Events配信までは完了できません。次の選択は、Orcaのhost-events権限を持つplugin導入を許可するか、session識別子と対象filterを備えた上流APIを用意するかです。callback鍵の保存・外向き送信と、MCP側の購読所有者認証も別途確定します。

## 初回確認結果（旧入口）

| 境界              | 結果                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| bridgeのSDK       | 固定依存 `@modelcontextprotocol/sdk@1.32.0` の最新対応版は `2025-11-25`。必須の `2026-07-28` は対応版リストにない                                  |
| bridgeのメソッド  | 合成stdio接続で `server/discover` と `events/list` はJSON-RPC `-32601`。この検査は現行SDKによる初期化後のメソッド検査で、MCP 2.0の適合試験ではない |
| Secure MCP Tunnel | v0.0.15の公式設定資料には `2026-07-28` 以降の自己完結要求の転送が記載される。Eventsの実接続・認証主体の伝達は未検証                                |
| Orca              | 公式資料はworking/waiting/done hooksとターン終了・入力待ちのfeedを説明する。これらのページだけでは外部購読APIの契約は確定しない                    |
| dot               | 通常のtools成功はEvents成功の証拠にならない。購読・callback検証・実通知は未実施                                                                    |

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)はMCP 2.0、永続購読、外向きHTTPS callbackを要求します。同じ認証済みMCP endpointでdiscoveryと購読管理を提供する必要があります。dotも対応先に含まれます。

Tunnelの根拠は[公式v0.0.15設定資料のstdio initialization guard](https://github.com/openai/tunnel-client/blob/v0.0.15/docs/configuration.md#stdio-mcp-servers)です。bridgeのSDK未対応を、Tunnel全体の非対応と解釈しないでください。

Orcaの根拠は[Agent hooks & memory](https://www.onorca.dev/docs/agents/hooks-memory)と[Agents feed](https://www.onorca.dev/docs/activity)です。managed hookのendpoint設定は読み取らず、変更もしていません。画面上のidleやログの無出力だけで完了イベントを生成しません。

## オフライン再現

```sh
npm run build
node scripts/check-events-compatibility.mjs
```

合成Orca fixtureを指定した別のstdioプロセスのみを使います。稼働中のTunnelへの接続、実Orcaの呼び出し、購読作成、鍵の読み取り、callback送信は行いません。出力は固定ラベルで、raw errorは表示しません。

現時点の期待値は `sdkSupportsRequiredProtocol: false`、両メソッドが `method_not_found`、`tunnelEventsVerified: false`、`dotDeliveryVerified: false` です。終了コード0は調査コマンドの実行成功だけを表し、Events対応を意味しません。接続失敗は終了コード1です。

## 実装を進める条件

1. 新入口のMCP 2.0 toolsは合成検証済み。以下の認証・イベント取得条件を満たしてからEventsのdiscoveryと購読backendを実装する。
2. Tunnelからbridgeへ認証済み購読所有者をどう伝えるか確定する。所有者・callback・対象filterごとに購読を分離し、更新・解除にも所有者検査を適用する。呼び出し引数の自己申告user IDを認証として扱わない。
3. Orcaのイベント取得契約をバージョン固定で確認する。正確なhost/worktree/session識別子、ターンID、発生時刻を合成fixtureで検証し、曖昧な対象は拒否する。既存managed hooksの差し替えや全セッション監視は行わない。
4. 以下の合成試験を満たす配信層を実装する。callbackと署名鍵の保存方式・保存先・保持期間・外向き送信先を具体化し、実運用への適用前に承認を得る。
5. ユーザーが監視対象を指定した後、pluginのevent discovery、単一購読、callback検証、合成イベントの実配送、dotでの受信と応答を順に確認する。HTTP受理とdotの応答を別々に記録する。

## 配信層の検証項目

以下の合成試験を `test/events.test.ts` に追加しました。実ネットワーク、実Orcaイベント、実ストレージと鍵管理、dot受信の検証は含みません。詳細は[通知コア](notifications-design.md)を参照してください。

- 署名：既知ベクトル、本文改変、期限切れ、challenge不一致、鍵ローテーション。
- 購読：同一要求の冪等性、所有者不一致、期限切れ、解除、権限失効、再起動後の復旧。
- 配送：同一イベントの再送時もID維持、重複抑制、順序変化、上限付きbackoff、410/413で停止。
- filter：別host/worktree/sessionの除外、曖昧な対象・欠けた識別子の拒否。
- 通知集中：queue上限、購読単位のquota、終了と入力待ちの重複・連続遷移の扱い。
- callback：HTTPS限定、private/loopback/link-local等の拒否、DNS再束縛対策、検証済みIPへの接続、TLS hostname検証、redirect拒否。検証要求にも同じ制約を適用。

新しい公開endpointやCloudflareは作成していません。callbackへの外向き送信と、自前の公開受信口の作成は別です。現行clientの停止・再起動、永続権限の追加も行っていません。
