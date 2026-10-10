# 停止・再開と、よくあるつまずき

- CLIの状態確認は毎回終了します。再開はbridgeフォルダで同じコマンドを実行するだけです。新しいターミナルでは[CLI で使う](cli.md)の手順1・3の環境変数も設定し直します。
- 手動起動したMCPはそのターミナルで`Ctrl+C`、クライアント管理のMCPはクライアント側で切断・停止します。再開は再接続してください。bridge停止ではOrca内のagentは停止しません。
- Orcaを終了・再起動した場合はアプリを開き、[CLI で使う](cli.md)の手順1のruntime確認からやり直します。端末handleは再取得してください。自動起動・常駐化するのは、`setup`（またはメニューバーアプリ）で自動起動を指定した状態確認用のTunnelだけです。

| 症状                                             | 確認すること                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `node` / `npm` / `git`が見つからない             | [CLI で使う](cli.md)の手順1の導入後、ターミナルを開き直す                                    |
| `cli_missing` / `orca`が見つからない             | OrcaのCLI登録と`command -v orca`を確認し、`ORCA_BIN`を設定する                               |
| `cli_failed` / `timeout` / runtimeへの接続エラー | Orcaが起動中か、同じユーザーかを確認。先に`orca status --json`を通す                         |
| `schema_changed`                                 | Orca CLIとアプリの版を確認。応答形式の互換性問題なので、キーの作成では解決しない             |
| `dist/cli.mjs`がない                             | clone先に`cd`し、`npm ci --ignore-scripts`と`npm run build`の成功を確認                      |
| 一覧が空 / 名前で見つからない                    | Orcaで作業を開き、`overview`で対象を探す。repoと作業名は完全一致                             |
| MCPで送信ツールが見えない                        | `ORCA_BRIDGE_ENABLE_SEND=1`にして再接続。`ORCA_BRIDGE_STATUS_ONLY=1`は送信より優先される     |
| dotからの送信が`send_disabled`になる             | ChatGPTのプラグイン管理画面で「指示の送信を許可」をオンにする                                |
| プラグイン管理画面に設定欄が出ない               | `setup`を再実行してから、管理画面で「ツールを更新」を押す                                    |
| `setup`で`unmanaged_file_exists`                 | 手作業で作ったprofileなどがある。表示されたファイルを別の場所へ移してから再実行              |
| `setup`で`*_mismatch` / `*_incomplete`           | 鍵とファイルが食い違っている。表示に従って両方を消し、再実行                                 |
| `setup doctor`で`status-tunnel`が`skip`          | Tunnelが動いていない。`--install-agent`で登録するか、`launchctl print`で状態を確認           |
| 検証で`EPERM`                                    | 実行環境の承認手順を確認。通常テストにもローカルsocket通信が必要。OSの保護機能を無効にしない |
