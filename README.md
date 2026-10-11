# Orca → dot bridge

[Orca](https://www.onorca.dev) で進めている AI エージェントの作業状態を、ChatGPT の音声アシスタント（dot）から確認し、必要なら指定した1つのエージェントへ追加の指示を送るための bridge です。macOS 専用です。

_A bridge that lets ChatGPT (dot) check the status of agents running in Orca on your Mac, and optionally send one explicit instruction to one agent. macOS only._

| 機能                                                                           | 状態                                                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| dot から Orca の状態を確認する                                                 | 利用可能                                                                                                                                           |
| dot から1つのエージェントへ追加の指示を送る                                    | 利用可能・既定はオフ（ChatGPT のプラグイン設定で許可。実エージェントへの送信は未検証）                                                             |
| dot からエージェントの質問・承認待ちに答える                                   | 利用可能・既定はオフ（「指示の送信を許可」で許可。実エージェントでの動作は未検証）                                                                 |
| dot からワークスペースを作る・エージェントを終了する・ワークスペースを削除する | 利用可能・3つとも既定はオフ（ChatGPT のプラグイン設定でそれぞれ許可。実環境での動作は未検証）                                                      |
| エージェントのターン終了などを dot へ自動通知する                              | Orca の experimental plugin（Agent Status Relay）を利用。ペイン単位で、既定はオフ（ChatGPT のプラグイン設定で許可）。[詳細](docs/notifications.md) |

## アーキテクチャ

```mermaid
flowchart LR
  subgraph cloud["ChatGPT"]
    dot["dot（個人用プラグイン 1 つ）"]
    settings["プラグイン設定<br/>「指示の送信を許可」「エージェントの終了を許可」<br/>「ワークスペースの作成を許可」「ワークスペースの削除を許可」「通知を受け取る」"]
  end
  subgraph mac["Mac（同じログインユーザー）"]
    app["メニューバーアプリ<br/>初回の準備・状態表示"]
    tunnel["tunnel-client<br/>（LaunchAgent で常駐）"]
    bridge["bridge サービス（常駐）<br/>127.0.0.1:8787"]
    relay["Agent Status Relay<br/>（Orca のプラグイン、任意）"]
    orca["Orca（CLI / runtime）"]
  end
  dot -- "MCP（Secure MCP Tunnel）" --> tunnel
  settings -. "設定の読み書き" .-> tunnel
  tunnel -- "HTTP（ローカルのみ）" --> bridge
  bridge -- "Orca CLI" --> orca
  orca --> relay
  relay -- "ペインの状態変化" --> bridge
  bridge -. "通知（webhook）" .-> dot
  app -. "setup" .-> bridge
```

- dot は 1 つの Secure MCP Tunnel で Mac 上の bridge サービスを呼びます。Tunnel クライアントは Mac から外へ接続するだけで、Mac でポートを開きません。bridge サービスが待ち受けるのは `127.0.0.1` だけです。
- bridge サービスが公開するツールは `orca_brief`（全体の様子を 1 回で要約）、`orca_find`（名前や状態からの候補探し）、`orca_status`（状態確認）、`orca_pending_input`（入力待ちのエージェントが何を聞いているかの確認）、`orca_send_instruction`（指定した1端末への追加指示）、`orca_answer`（質問・承認待ちへの回答）、`orca_create_workspace`（ワークスペースの作成と、任意でエージェントの起動）、`orca_close_agent`（エージェントのターミナルを閉じる）、`orca_remove_workspace`（ワークスペースの削除）、`orca_recent_notifications`（届いた通知の確認）、`orca_set_alias`・`orca_remove_alias`（ワークスペースの呼び名の登録・削除）と、ChatGPT の設定画面用の2つです。送信と回答は「指示の送信を許可」、作成・終了・削除はそれぞれ「ワークスペースの作成を許可」「エージェントの終了を許可」「ワークスペースの削除を許可」、通知は「通知を受け取る」を ChatGPT のプラグイン管理画面でオンにしたときだけ受け付けます。どれも既定はオフで、オンにできるのはプラグイン管理画面からだけです。
- メニューバーアプリは、Tunnel ができる前の初回準備と、Tunnel が動いているかの表示を受け持ちます。設定や許可は ChatGPT 側の画面で行います。

詳しくは[アーキテクチャと実装状況](docs/architecture.md)を参照してください。

## 使い方

必要なもの: macOS、[Orca](https://www.onorca.dev)（CLI を登録済み）、ChatGPT のアカウントと [OpenAI Platform](https://platform.openai.com/) へのアクセス。

1. **アプリを入れる。** Homebrew では `brew install --cask andoshin11/tap/orca-dots-bridge` で入ります（更新は `brew upgrade --cask orca-dots-bridge`）。手動で入れる場合は、[Releases](https://github.com/andoshin11/orca-dots-bridge/releases/latest) から `Orca-Dots-Bridge-<版>-mac-arm64.zip`（Intel Mac は `-mac-x64.zip`）をダウンロードして展開し、**Finder で**「アプリケーション」フォルダへドラッグして移してから開きます。どちらの方法でも、開発者署名をしていないため、初回は「開いていません」と表示されます。「完了」を押し、「システム設定」→「プライバシーとセキュリティ」の「このまま開く」を押して、確認のダイアログで再度「このまま開く」を選び、Mac のログインパスワードを入力します（1回だけです）。
2. **アプリの画面に沿って準備する（初回だけ）。** 各手順に Platform・ChatGPT の画面のスクリーンショットがあります。
   1. Platform で Tunnel を 1 つ作り、ID を貼り付ける
   2. Platform で runtime キー（Restricted、Tunnels の Read と Use、期限付き）を作ってコピーする
   3. 「セットアップを実行」を押す（tunnel-client の導入と、bridge サービス・Tunnel のログイン時の自動起動まで行います）
   4. ChatGPT で「カスタム MCP サーバー」を 1 つ追加する（接続タイプはトンネル、認証なし）
3. **dot から使う。** 「Orca の ○○ の作業はどうなってる？」「orca-dots-bridge の debug のワークスペースは？」「入力待ちのエージェントはいる？」のように、ふだんの言葉で聞きます。正確な名前や ID を伝える必要はありません。dot が候補を探し、複数当てはまるときはどれかを確かめます。指示も送りたい場合は、ChatGPT のプラグイン管理画面で「指示の送信を許可」をオンにします。

   声で使いやすくするために、次のことができます。

   - 「どうなってる？」「何か待ってる？」と聞くと、dot が `orca_brief` を 1 回だけ呼び、入力待ちのエージェント（何を待っているか）、最近終わった作業（直前の発言の要約）、作業中のワークスペースの名前を短くまとめて答えます。「orca-dots-bridge はどうなってる？」のように絞ることもできます。端末の画面は読みません。
   - 名前は聞き間違いに強く探します。大文字小文字・全角半角・空白やハイフンの有無・カタカナとひらがなの違い、「orca-dots-bridgeのdebug」のような区切りのない言い方、「bridge」と「birdge」のような小さな綴りの違いを許します（どう一致したかを dot が受け取り、あいまいな一致は確かめます）。
   - それでも通じにくい名前には、呼び名（エイリアス）を付けられます。「debug-birdge を『でばっぐ』って呼ぶようにして」と頼むと、dot が `orca_set_alias` で登録し、以後「でばっぐはどうなってる？」で通じます。呼び名はこの Mac の `~/.orca-dots-bridge/aliases.json`（権限 600、最大 50 件）に保存するだけで、Orca には何も送りません。そのため設定でのオン・オフはありません。消すときは「『でばっぐ』の呼び名を消して」と頼みます。

   「指示の送信を許可」がオンなら、エージェントの質問や承認待ちにも声で答えられます。たとえば次の流れです。

   1. 通知が届く（「○○ のエージェントが入力を待っています」。通知には直前の発言の要約と、何を待っているか（実行しようとしているコマンドなど）が付きます）
   2. 「何を聞かれてる？」と聞く。dot が `orca_pending_input` で、質問と、端末にいま表示されている選択肢（「1. Yes」「2. Yes, and don't ask again …」「3. No …」など）を読み上げます
   3. 「1番で」と答える。dot が `orca_answer` でその番号だけを送ります

   番号は、その番号の選択肢が端末に実際に表示されているときだけ送ります（表示されていなければ何も送りません）。dot が代わりに選ぶことはなく、削除や force push のような危険なコマンドの承認は、内容を確かめてから答えてください。

   ワークスペースの作成（「新しいワークスペースを作って codex にこの修正を頼んで」）、エージェントの終了、ワークスペースの削除も、それぞれ「ワークスペースの作成を許可」「エージェントの終了を許可」「ワークスペースの削除を許可」をオンにすると頼めます。強い操作なので既定はオフです。作成で起動したエージェントはこの Mac 上で Orca の通常の権限で動きます。削除は元に戻せません（メインのチェックアウトと、コミットしていない変更があるワークスペースは削除しません）。実行の前に dot が内容を確認します。

4. **（任意）自動通知を使う。** Orca の「設定」→「プラグイン」→「ソースを管理」で Git のソース `https://github.com/andoshin11/orca-plugins`（ref は `main`）を追加し、**Agent Status Relay** をインストールして「プラグインを有効にする」を押します（権限は events:subscribe）。そのうえで ChatGPT のプラグイン管理画面で「通知を受け取る」をオンにします。Tunnel やプラグインを追加する必要はありません。「全部のエージェントの入力待ちを教えて」「このリポジトリの作業が終わったら教えて」のように頼むと、1 つの購読でまとめて通知します（あとから作ったワークスペースも含みます）。詳しくは[自動通知](docs/notifications.md)を参照してください。

### 以前の 2 つの Tunnel の構成から移る

以前は状態確認用と通知用に Tunnel と ChatGPT プラグインを 2 つずつ使っていました。今は 1 つずつです。

1. 新しいアプリを開きます（更新後の初回起動で自動的に移行します）。CLI の場合は `node dist/setup.mjs --install-agent` を実行します。状態確認用の Tunnel ID をそのまま使い、古い LaunchAgent と profile を片付けます。
2. ChatGPT で状態確認用のプラグイン（Orca Status など）の管理画面を開き、「ツールを更新」を押します。
3. 通知用に作ったプラグインは ChatGPT で削除します。Platform の通知用 Tunnel も、不要なら削除できます。
4. dot に通知の購読をもう一度頼みます。

runtime キーの期限が近づいたら、新しいキーをコピーしてアプリの「コピーした新しいキーに入れ替える」で入れ替えます。うまく動かないときは[よくあるつまずき](docs/troubleshooting.md)を参照してください。

### CLI で使う

アプリを使わず、ターミナルから状態を確認したり `setup` を実行したりもできます。Releases の `orca-dots-bridge-<版>.tar.gz` を展開すれば、Node.js 22 以上だけで動きます。

```sh
node dist/cli.mjs status --repo <repo> --name <作業名>
pbpaste | node dist/setup.mjs --runtime-key-stdin --tunnel-id <Tunnel ID> --install-tunnel-client --install-agent
```

アプリと CLI の `setup` はどちらも同じ bridge サービスと Tunnel を設定します。片方だけを使ってください（あとから実行した方の bridge をサービスが使います）。

## ドキュメント

| 文書                                             | 内容                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [メニューバーアプリ](docs/menu-bar-app.md)       | 置き場所、更新、キーの扱い                                               |
| [ChatGPT（dot）から使う](docs/chatgpt-tunnel.md) | `setup` の詳細、プラグイン設定、手作業での Tunnel 構成                   |
| [CLI で使う](docs/cli.md)                        | CLI のリファレンス、MCP クライアントからの利用、状態の読み方             |
| [アーキテクチャと実装状況](docs/architecture.md) | 通信経路、認証、検証の範囲                                               |
| [自動通知](docs/notifications.md)                | 準備と使い方、仕組みと制約（[実装と検証](docs/notifications-design.md)） |
| [開発](docs/development.md)                      | ビルド、テスト、リリース                                                 |

## ライセンス

脆弱性の報告は [SECURITY.md](SECURITY.md) を参照してください。

[MIT](LICENSE)。第三者のライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) と、配布物の `dist/THIRD_PARTY_LICENSES.md` を参照してください。
