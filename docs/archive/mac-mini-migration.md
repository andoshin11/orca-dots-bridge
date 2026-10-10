# Mac miniへの移行手順

> アーカイブ: 開発中の記録として残している文書です。現在の使い方は [README](../../README.md) を参照してください。

これは未実施の移行手順です。Mac mini上の操作・起動・インストールを今回の公開作業で行ったものではありません。既存のstatus/sendと通知試験は別接続で扱います。

## 1. ソースの検証

Mac miniでの作業が承認された後、専用ディレクトリにこのrepoをcloneし、検証するcommitを固定します。READMEのNode要件に合う環境で、認証情報を渡さずに次を実行します。

```sh
npm ci --ignore-scripts
npm run verify
```

これは依存導入と合成検証です。Tunnel、Keychain、Orca runtime、実購読は作成・起動しません。実運用のdistを上書きせず、専用checkoutで検証してください。

## 2. 対応Orcaの準備

通知試験には、隔離Orca 1.4.220を基に追加した対象限定RPCが必要です。通常版Orcaだけでは不足し、その変更はこのrepoに同梱していません。対応ソース・build・RPC契約を別途レビューして準備するまでは、通知試験を開始できません。個人用launcherも同梱していないため、以下は運用者向けの統合手順であり、ワンコマンドのセットアップではありません。

Mac mini専用の隔離profileとruntimeを準備し、当該runtimeの認証付きIPCで1対象の完全な識別情報を取得します。以前の端末handle、session、runtime ID、socket、profile、tokenを別マシンから流用しません。runtimeが対応RPCと対象同一性を返せない場合は停止します。

## 3. 承認する具体的な範囲

起動前に、監視する1セッション、最長10分の期限、個人workspace、専用Tunnel/plugin、loopbackポート、保存先、許可callbackドメインを確定します。共有設定とサービスアカウントの権限も確認してください。APIキー認証は単一サービス主体であり、本人認証の代替証明ではありません。

キーの作成・保存・読取、専用接続の登録、実購読、外向き確認通信は、それぞれこの具体的範囲で承認を得て行います。既存のstatus/send接続を切り替える案を採る場合は、その停止時間と元設定への切戻しも承認対象です。別接続で実施する限り、既存status/sendを停止する必要はありません。

## 4. 二段階の試験

利用者が管理するローカルプロセスで、専用32バイトキーをmacOS Keychainに準備します。実装上のservice名は`orca-dots-bridge.notifications-test`、accountは`service-v1`と`outbox-v1`です。Mac上のターミナルで`node dist/trial-key-setup.mjs`を実行すると両方を作成し、dotプラグインのAPIキーをstderrに1回だけ表示します（手順は[relay pluginによる通知](../relay-notifications.md)の「試験用の鍵を作る」を参照）。既存accountを上書きしません。キー・runtime token・callback URLをチャット、argv、Git、通常ログへ出さないでください。

`src/events/trial-runner.ts`の`twoPhaseTrialConfigSchema`と`src/events/two-phase-endpoint.ts`のscope schemaに従う設定を用意します。`dist/notification-two-phase.mjs`のstdinへ初期設定とruntime tokenを1レコードで渡し、stderrはprivate TTYに接続します。対象hashと期限を含むscopeの承認文言はschemaで検証されます。専用Tunnelから認証付きloopback endpointへ接続します（設定は[通知用Tunnelの設定](../notification-tunnel.md)）。

購読を1回作成し、確認通信が成功した後、private TTYに表示されたURL全文を確認します。通知を承認する場合だけ、同じstdinへ`activate`レコードを別途渡します。正確な入力契約は`src/notification-two-phase.ts`と`test/two-phase-cli.test.ts`を参照してください。URLの本人への帰属が独立に確認できない場合、その限界を明示した限定試験として承認するか、そこで中止します。

対象セッションでイベントを発生させ、固定診断の送信結果と製品側webhook受信、dot側の応答を別々に確認します。両イベント種別を検証するには種別を特定できる証拠が必要です。期限は途中で延長せず、失敗時の再購読・再送も自動では行いません。

## 5. 終了・切戻し

期限到達またはSIGINT/SIGTERMで試験入口を終了し、監視終了、listener解放、試験状態の消去を確認します。専用Tunnelプロセスと製品側の試験タスクも停止します。Keychainキーは自動削除されないため、保持・削除は別途判断します。

既存接続を変更していなければ、そのままstatus/sendを継続できます。切替を行った場合は試験側を停止してから保存した元のupstream設定に戻し、読み取りstatusで復帰を確認します。終了記録を確認できないときは再試験を始めず、残存プロセス・ロック・購読を調査してください。常駐化・自動起動・24時間運用はこの試験手順の対象外です。
