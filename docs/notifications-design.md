# 通知実装・検証範囲

Orcaのペインごとのターン終了・入力待ちを通知します。プロジェクト全体の完了判定ではありません。既定のstdio MCPとstatus/sendの起動設定は変えず、通知は常駐の通知サービス（`dist/notification-service.mjs`）が担います。使い方は[自動通知](notifications.md)を参照してください。

## 実装

| ファイル                                                                  | 役割                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/notification-service.ts`、`src/events/notification-service.ts`       | 常駐の通知サービス。Keychainの鍵を読み、MCP Events入口・relay受け口・購読の保存と再開をまとめる |
| `src/events/pane-contract.ts`、`pane-rpc.ts`、`relay-ingress.ts`          | ペイン単位の対象とcatalog、relay pluginのメッセージ検証、イベントごとのペイン再確認と監視の停止 |
| `src/events/engine.ts`、`model.ts`、`orca-contract.ts`、`orca-adapter.ts` | 購読所有者の分離、期限・解除、権限再検査、重複抑制、暗号化outbox、上限付き再配送                |
| `src/events/http-entry.ts`、`loopback-server.ts`、`service-key.ts`        | loopback限定のMCP Events HTTP入口と、専用32バイトキーによる単一サービス主体の認証               |
| `src/events/file-store.ts`、`keychain.ts`                                 | 暗号化状態のatomic保存・排他、macOS Keychainへの明示的アクセス                                  |
| `src/events/webhook.ts`                                                   | Standard Webhooks署名、送信先制約、TLS検証、DNSと送信を合わせた時間制限                         |
| `src/events/preflight-diagnostics.ts`、`delivery-diagnostics.ts`          | 秘密・URL・raw errorを記録しない固定診断分類                                                    |

保証はペイン単位に限定しています（`orca.pane_activity`と種類別のイベント）。session/turnを推測するのではなく、ペイン単位であること・取りこぼしを検出できないことを、イベント（`assurance: "pane_only"`）とcatalogの説明に明示します。

以前は、専用RPCを追加したOrcaを使うセッション単位の経路（`orca.session_activity`）と、1対象・承認から最長10分で自動停止する試験用の入口（`notification-trial`・`notification-two-phase`・`notification-preflight`・`notification-approval-check`）がありました。常駐版の通知サービスに置き換えたため削除しました。engineには`orca.session_activity`用のschemaが残っていますが、それを使う入口はありません。

## 送信先の制約

通知先は許可hostのHTTPS・443に限定します。送信ごとにIPv4のDNS回答すべてを検査し、1つでも非公開アドレスがあれば拒否します。接続IPを固定し、元のhostnameでTLSを検証します。IPv6-onlyは非対応、redirectは禁止です。DNSからHTTP応答までの上限は10秒で、終了時には保留送信を中止します。

exactly-once保証もsource replayもありません。HTTP成功は受信側での受理を示し、dotでの表示・音声応答を保証しません。

## 認証・本人限定利用

専用APIキーの所有者は`service:trial-service-v1`というサービス主体であり、人間の本人識別ではありません。個人workspaceのOwnerが1人で招待group表示がないことを確認した範囲でも、全ての共有経路やサービスアカウント権限を証明したことにはなりません。確認通信への応答も、そのURLが本人アカウントに属することの証明にはなりません。

[MCP Eventsガイド](https://developers.openai.com/plugins/build/mcp-events)と[製品Authガイド](https://developers.openai.com/plugins/build/auth)は分けて扱います。API-key主体はEvents draftで許容される一方、製品AuthガイドはOAuthを期待しています。今回のサービスキー方式は限定実試験で動作しましたが、一般的な認証互換性・共有利用への適合は未確定です。有料Auth0や新規OAuth基盤を必須にはしていません。Tailscaleの設定だけでクラウド側の本人識別が成立するわけでもありません。

## 検証結果（2026-10-08、試験用の入口）

以下は、削除した試験用の入口で行った検証の記録です。

2026-10-08の隔離実試験では、確認通信1回と購読作成1回が成功しました。追加承認後、イベント送信1回が成功し、製品側webhook起動を確認しました。追加の購読要求1回は拒否され、終了時の別送信試行1回はキャンセルされました。イベント種別は固定診断から確定できないため、ターン終了・入力待ちの両方を実証したとは扱いません。dot画面・音声の最終応答、長期運用、Mac mini移行も未検証です。

試験は期限で終了し、プロセス・listener・ロックの解放と製品側タスクの停止を確認しました。個人用launcher、runtime profile、認証情報、実callback URL、診断原本は公開物に含めていません。当時の移行の準備と切戻しは[Mac miniへの移行手順](archive/mac-mini-migration.md)に残しています。
