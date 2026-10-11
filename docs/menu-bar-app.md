# メニューバーアプリ

`setup`コマンドを画面から行う macOS のメニューバーアプリ（Electron）です。メニューバーに状態（`Orca ✓` / `Orca !` / `Orca ✕`）を表示し、Tunnel の稼働を30秒ごと、`setup doctor`相当の確認を10分ごとに行います。

Homebrew では `brew install --cask andoshin11/tap/orca-dots-bridge` で入ります（tap は [andoshin11/homebrew-tap](https://github.com/andoshin11/homebrew-tap)。リリースのたびに自動で更新されます）。手動で入れる場合は、[GitHub Releases](https://github.com/andoshin11/orca-dots-bridge/releases/latest) の`Orca-Dots-Bridge-<版>-mac-arm64.zip`（Intel Mac は`-mac-x64.zip`）を展開し、`Orca Dots Bridge.app`を「アプリケーション」へ移して開きます。bridge はアプリに同梱されていて、Node.js も clone も不要です。

- **初回の起動:** 開発者署名をしていないため、macOS が「“Orca Dots Bridge”は開いていません」と表示します。「完了」を押し、「システム設定」→「プライバシーとセキュリティ」に出る「このまま開く」を押します。確認のダイアログでもう一度「このまま開く」を選ぶと、Mac のログインパスワードを求められます（1回だけです）。
- **削除:** `brew uninstall --cask --zap orca-dots-bridge` は、アプリに加えて常駐サービスを止め、`~/.orca-dots-bridge` も消します（Keychain の鍵は残ります）。`--zap` を付けない削除や `brew upgrade` では、常駐サービスは止めません。
- **Finder で移してから開く:** ダウンロードしたアプリを Finder 以外の方法で移したり、ダウンロードフォルダのまま開いたりすると、macOS はアプリを一時的な場所で実行します（App Translocation）。その場合アプリは何も変更せず、「アプリケーション」へ移すよう案内して終了します（一時的な場所を bridge サービスが参照すると、再起動後に動かなくなるためです）。
- **bridge の置き場所:** アプリは起動時に、同梱の bridge を`~/.orca-dots-bridge/runtime/<版>/`へコピーし、自身の Electron を Node.js の代わりとして`~/.orca-dots-bridge/runtime/node`にリンクします。bridge サービス（LaunchAgent）はここを使うため、アプリを終了していても動きます。アプリを移動・更新したら、一度起動すれば張り直します。

- 画面の手順に沿って、Tunnel ID の貼り付け → runtime キーのコピー →「セットアップを実行」→ ChatGPT のプラグイン作成（1 つ）→（任意）Orca に Agent Status Relay を入れる、と進めます。Tunnel もプラグインも 1 つです。通知を受け取るかどうかは、アプリではなく ChatGPT のプラグイン設定「通知を受け取る」で切り替えます。Agent Status Relay は、Orca の「設定」→「プラグイン」→「ソースを管理」で Git のソース `https://github.com/andoshin11/orca-plugins`（ref は `main`）を追加し、インストールして「プラグインを有効にする」を押します（権限は events:subscribe）。Platform・ChatGPT の該当ページはボタンで開けます。各手順には、押す場所に赤枠を付けた Platform・ChatGPT 画面のスクリーンショット（`app/images/`、ID などの識別子は塗りつぶし済み）を載せています。画像を押すと拡大します。
- runtime キーはクリップボードから main プロセスが直接読み、保存できたらクリップボードを空にします。画面（renderer）にはキーを渡しません。クリップボードの中身が runtime キーの形式でなければ、読み取りも消去もしません。
- 送信や通知の許可などの設定は、このアプリではなくChatGPTのプラグイン管理画面で行います（[ChatGPT（dot）から使う](chatgpt-tunnel.md)の「指示の送信を許可」、[自動通知](notifications.md)の「通知を受け取る」）。アプリが受け持つのは、Tunnelができる前の初回準備と、Tunnelが止まっていないかの表示です。
- **操作の記録:** dot（ChatGPT）や stdio の MCP クライアントが bridge に頼んだ書き込み操作（指示の送信・回答・ワークスペースの作成・タスクの開始・エージェントの終了・ワークスペースの削除・呼び名の登録と削除・設定の変更）の新しい 30 件を、時刻・操作・対象・結果（完了・拒否・エラーとそのコード）・送った文面（先頭 200 文字）・どこからか（ChatGPT か stdio）で表示します。断られた操作や失敗した操作も載ります。「再読み込み」で読み直します。記録は bridge が `~/.orca-dots-bridge/audit.log`（権限 600、1 MB ごとに `audit.log.1` へ 1 世代だけ残す）に書いたもので、アプリは main プロセスでこのファイルを読むだけです（シンボリックリンクは読みません）。画面にはファイルの決まった項目だけを文字として渡し、キーや secret は記録にも画面にも含みません。
- 「ログイン時に起動」をオンにすると、アプリ自体もログイン時に起動します（bridge サービスと Tunnel の自動起動とは別です。どちらもアプリを起動していなくても LaunchAgent で動きます）。
- ソースからビルドする方法は[開発](development.md)を参照してください。

## 更新

- **自動の確認:** 起動の約30秒後と、その後6時間ごとに、GitHub の最新リリース（`https://api.github.com/repos/andoshin11/orca-dots-bridge/releases/latest`）を確かめます。下書きとプレリリースは対象外です。新しい版があると、メニューに「アップデートがあります（vX.Y.Z）」、画面の上にリリースノートへのリンク付きのお知らせを出します。押すまで何も入れ替えません。メニューの「アップデートを確認」で今すぐ確かめられます。「自動で更新を確認する」（既定はオン）をオフにすると、自動の確認をやめます。「この版をスキップ」した版は、自動の確認では知らせません（手動で確認したときは表示します）。最終確認の時刻とこれらの設定は、アプリのデータフォルダ（Electron の userData。通常は `~/Library/Application Support/orca-dots-bridge-app/update.json`）に保存します。オフラインや GitHub の利用制限のときは、自動の確認では何も表示しません。
- **Homebrew で入れた場合:** アプリが `/Applications/Orca Dots Bridge.app` にあり、Homebrew の Caskroom に `orca-dots-bridge` があれば、Homebrew で入れたものとして扱います。この場合アプリは自分では入れ替えず、「Homebrew で更新」で `brew upgrade --cask andoshin11/tap/orca-dots-bridge` を実行します（ログインシェルの PATH を使い、管理者権限は使いません）。成功したら新しい版のアプリを開き直します。失敗したときは出力と、ターミナルで実行するコマンドを表示します。
- **手動で入れた場合:** 「ダウンロードして更新」で、この Mac 用（Apple シリコンは arm64、Intel は x64）の zip と `SHA256SUMS` を同じリリースから一時フォルダへダウンロードし、次を確かめてから入れ替えます。
  - zip の SHA-256 が `SHA256SUMS` の行と一致する
  - 展開した `Orca Dots Bridge.app` の識別子（`CFBundleIdentifier`）が今のアプリと同じで、版（`CFBundleShortVersionString`）がリリースの版と同じ
  - `codesign --verify --deep --strict` が通る（開発者署名ではなく ad hoc 署名です）

  確認が済むとアプリは終了し、小さな補助スクリプトが、アプリの終了を待ってから今のアプリを一時フォルダへ退避し、新しいアプリを同じ場所へコピーして開きます。コピーに失敗したときは退避したアプリを元に戻して開きます（次の起動で「更新を完了できませんでした」と表示します）。アプリのあるフォルダに書き込めない場合、名前が `Orca Dots Bridge.app` でない場合、一時的な場所で実行されている場合（App Translocation）は入れ替えず、リリースページから zip を入れて置き換えるよう案内します。管理者権限では実行しません。アプリが行うダウンロードには macOS の隔離属性（`com.apple.quarantine`）が付かないため、更新後に「開いていません」は通常表示されません。補助スクリプトは拡張属性を付けも外しもしません。

- **更新後の起動:** 新しい版は起動時に bridge を `~/.orca-dots-bridge/runtime/<新しい版>/` へコピーし、自動起動を入れていれば bridge サービスを新しい版へ切り替えます。そのあと、今の版より古い `runtime/<版>/` のうち、すぐ前の 1 つと、LaunchAgent や Tunnel の profile が参照しているものを残して削除します（`X.Y.Z` の名前のフォルダ以外には触れません）。
- **以前の構成から:** 以前の 2 つの Tunnel の構成（状態確認用と通知用）で動いていた場合は、更新後の初回起動で 1 つの Tunnel へ自動で移行します（そのあと ChatGPT で行うことは README の「[以前の 2 つの Tunnel の構成から移る](../README.md#以前の-2-つの-tunnel-の構成から移る)」を参照してください）。
- **安全性:** アプリは開発者署名も公証もしていないため、更新の正しさは「GitHub のこのリポジトリのリリースから HTTPS で取得し、同じリリースの `SHA256SUMS` と一致する」ことに頼っています（別の署名はありません）。識別子と版の確認で、別のアプリや別の版との入れ替えを防ぎます。GitHub のリリースそのものが書き換えられた場合は防げません。気になる場合は「自動で更新を確認する」をオフにし、Homebrew か手動で更新してください。
