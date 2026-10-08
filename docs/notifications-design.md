# 通知実装・検証範囲

指定した1セッションのターン終了・入力待ちを通知します。プロジェクト全体の完了判定ではありません。既定のstdio MCPとstatus/sendの起動設定は維持し、通知は専用入口を明示的に起動した場合だけ動作します。

## 実装

| ファイル                                                                                   | 役割                                                                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/events/orca-contract.ts`、`orca-adapter.ts`、`session-rpc.ts`、`runtime-transport.ts` | host・worktree・pane・terminal・session・世代を一致確認。認証付きUnix socket RPCから対象のイベントだけを取得 |
| `src/events/engine.ts`、`model.ts`                                                         | 購読所有者の分離、期限・解除、権限再検査、重複抑制、暗号化outbox、上限付き再配送                             |
| `src/events/http-entry.ts`、`service-endpoint.ts`、`service-key.ts`                        | MCP Events HTTP入口と、専用32バイトキーによる単一サービス主体の認証                                          |
| `src/events/file-store.ts`、`keychain.ts`                                                  | 暗号化状態のatomic保存・排他、macOS Keychainへの明示的アクセス                                               |
| `src/events/two-phase-endpoint.ts`、`trial-runner.ts`                                      | 最大10分・1対象、確認通信と通知送信の承認を分離。期限・終了時に監視・接続・試験状態を片付ける                |
| `src/events/webhook.ts`、`trial-verification-budget.ts`                                    | Standard Webhooks署名、確認通信1回、送信先制約、TLS検証、DNSと送信を合わせた時間制限                         |
| `src/events/preflight-diagnostics.ts`、`delivery-diagnostics.ts`                           | 秘密・URL・raw errorを記録しない固定診断分類                                                                 |
| `src/notification-two-phase.ts`                                                            | stdinの初期設定と後続承認を別レコードで受ける専用CLI。URL全文の確認表示はprivate TTYのみ                     |

`notification-trial.ts`は事前にURL承認が済んだ経路、`notification-preflight.ts`と`notification-approval-check.ts`は確認用です。これらはインストール時や通常MCP起動時に自動実行されません。

Orcaには`terminal.agentEvents.describe`と対象限定購読の専用RPCが必要です。隔離Orcaへの追加実装で試験しましたが、**Orca本体の変更はこのrepoに含めていません**。通常版のhost-events payloadからsession/turnを推測する代替経路はありません。対応runtimeを別途用意できるまで、実通知の移行は保留です。

## 試験の動作と制約

二段階入口は、対象と許可ドメイン、元の期限を固定して起動します。最初の購読で確認通信を1回だけ行い、成功しても監視は開始しません。利用者がprivate terminalで通知先URL全文を確認し、別の承認レコードを渡した後に対象を再検査して監視を開始します。再起動で承認や購読を自動復元せず、既存の試験状態がある場合は起動を拒否します。追加購読も拒否します。

通知先は許可hostのHTTPS・443に限定します。送信ごとにIPv4のDNS回答すべてを検査し、1つでも非公開アドレスがあれば拒否します。接続IPを固定し、元のhostnameでTLSを検証します。IPv6-onlyは非対応、redirectは禁止です。DNSからHTTP応答までの上限は10秒で、終了時には保留送信を中止します。

汎用engineには再配送と暗号化状態の復元がありますが、試験入口は永続運用や再起動後の継続監視を提供しません。exactly-once保証もsource replayもありません。HTTP成功は受信側での受理を示し、dotでの表示・音声応答を保証しません。終了時に試験状態を消去しますが、Keychainキーは保持します。Tunnelプロセスと製品側タスクの停止も別途必要です。

## 認証・本人限定利用

専用APIキーの所有者は`service:trial-service-v1`というサービス主体であり、人間の本人識別ではありません。個人workspaceのOwnerが1人で招待group表示がないことを確認した範囲でも、全ての共有経路やサービスアカウント権限を証明したことにはなりません。確認通信への応答も、そのURLが本人アカウントに属することの証明にはなりません。

[MCP Eventsガイド](https://developers.openai.com/plugins/build/mcp-events)と[製品Authガイド](https://developers.openai.com/plugins/build/auth)は分けて扱います。API-key主体はEvents draftで許容される一方、製品AuthガイドはOAuthを期待しています。今回のサービスキー方式は限定実試験で動作しましたが、一般的な認証互換性・共有利用への適合は未確定です。有料Auth0や新規OAuth基盤を必須にはしていません。Tailscaleの設定だけでクラウド側の本人識別が成立するわけでもありません。

## 検証結果

公開候補でlint・format・型検査・buildと224テスト（23ファイル）が成功しました。`npm run verify`はlint・format・型検査、build、その成果物を使うテストの順で実行します。合成対象・テスト鍵で、所有者分離、対象変更、期限、キャンセル、private承認、保存・排他、再起動拒否、診断の秘密非出力を検証します。実TLS handshakeを使うローカル受信器と、独立したWebCrypto署名検証器も含みます。製品callbackや実Keychainには接続しません。

2026-10-08の隔離実試験では、確認通信1回と購読作成1回が成功しました。追加承認後、イベント送信1回が成功し、製品側webhook起動を確認しました。追加の購読要求1回は拒否され、終了時の別送信試行1回はキャンセルされました。イベント種別は固定診断から確定できないため、ターン終了・入力待ちの両方を実証したとは扱いません。dot画面・音声の最終応答、長期運用、Mac mini移行も未検証です。

試験は期限で終了し、プロセス・listener・ロックの解放と製品側タスクの停止を確認しました。個人用launcher、runtime profile、認証情報、実callback URL、診断原本は公開物に含めていません。移行の準備と切戻しは[Mac miniへの移行手順](mac-mini-migration.md)を参照してください。
