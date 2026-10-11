# メニューバーアプリ

`setup`コマンドを画面から行う macOS のメニューバーアプリ（Electron）です。メニューバーに状態（`Orca ✓` / `Orca !` / `Orca ✕`）を表示し、Tunnel の稼働を30秒ごと、`setup doctor`相当の確認を10分ごとに行います。

Homebrew では `brew install --cask andoshin11/tap/orca-dots-bridge` で入ります（tap は [andoshin11/homebrew-tap](https://github.com/andoshin11/homebrew-tap)。リリースのたびに自動で更新されます）。手動で入れる場合は、[GitHub Releases](https://github.com/andoshin11/orca-dots-bridge/releases/latest) の`Orca-Dots-Bridge-<版>-mac-arm64.zip`（Intel Mac は`-mac-x64.zip`）を展開し、`Orca Dots Bridge.app`を「アプリケーション」へ移して開きます。bridge はアプリに同梱されていて、Node.js も clone も不要です。

- **初回の起動:** 開発者署名をしていないため、macOS が「“Orca Dots Bridge”は開いていません」と表示します。「完了」を押し、「システム設定」→「プライバシーとセキュリティ」に出る「このまま開く」を押します。確認のダイアログでもう一度「このまま開く」を選ぶと、Mac のログインパスワードを求められます（1回だけです）。
- **削除:** `brew uninstall --cask --zap orca-dots-bridge` は、アプリに加えて常駐サービスを止め、`~/.orca-dots-bridge` も消します（Keychain の鍵は残ります）。`--zap` を付けない削除や `brew upgrade` では、常駐サービスは止めません。
- **Finder で移してから開く:** ダウンロードしたアプリを Finder 以外の方法で移したり、ダウンロードフォルダのまま開いたりすると、macOS はアプリを一時的な場所で実行します（App Translocation）。その場合アプリは何も変更せず、「アプリケーション」へ移すよう案内して終了します（一時的な場所を bridge サービスが参照すると、再起動後に動かなくなるためです）。
- **bridge の置き場所:** アプリは起動時に、同梱の bridge を`~/.orca-dots-bridge/runtime/<版>/`へコピーし、自身の Electron を Node.js の代わりとして`~/.orca-dots-bridge/runtime/node`にリンクします。bridge サービス（LaunchAgent）はここを使うため、アプリを終了していても動きます。アプリを移動・更新したら、一度起動すれば張り直します。
- **更新:** Homebrew なら `brew upgrade --cask orca-dots-bridge` のあとアプリを起動します。手動なら新しい版の zip で`Orca Dots Bridge.app`を置き換えて起動します。自動起動を入れていれば、bridge サービスも自動で新しい版に切り替わります。以前の 2 つの Tunnel の構成（状態確認用と通知用）で動いていた場合は、更新後の初回起動で 1 つの Tunnel へ自動で移行します（そのあと ChatGPT で行うことは README の「[以前の 2 つの Tunnel の構成から移る](../README.md#以前の-2-つの-tunnel-の構成から移る)」を参照してください）。

- 画面の手順に沿って、Tunnel ID の貼り付け → runtime キーのコピー →「セットアップを実行」→ ChatGPT のプラグイン作成（1 つ）→（任意）Orca に Agent Status Relay を入れる、と進めます。Tunnel もプラグインも 1 つです。通知を受け取るかどうかは、アプリではなく ChatGPT のプラグイン設定「通知を受け取る」で切り替えます。Agent Status Relay は、Orca の「設定」→「プラグイン」→「ソースを管理」で Git のソース `https://github.com/andoshin11/orca-plugins`（ref は `main`）を追加し、インストールして「プラグインを有効にする」を押します（権限は events:subscribe）。Platform・ChatGPT の該当ページはボタンで開けます。各手順には、押す場所に赤枠を付けた Platform・ChatGPT 画面のスクリーンショット（`app/images/`、ID などの識別子は塗りつぶし済み）を載せています。画像を押すと拡大します。
- runtime キーはクリップボードから main プロセスが直接読み、保存できたらクリップボードを空にします。画面（renderer）にはキーを渡しません。クリップボードの中身が runtime キーの形式でなければ、読み取りも消去もしません。
- 送信や通知の許可などの設定は、このアプリではなくChatGPTのプラグイン管理画面で行います（[ChatGPT（dot）から使う](chatgpt-tunnel.md)の「指示の送信を許可」、[自動通知](notifications.md)の「通知を受け取る」）。アプリが受け持つのは、Tunnelができる前の初回準備と、Tunnelが止まっていないかの表示です。
- 「ログイン時に起動」をオンにすると、アプリ自体もログイン時に起動します（bridge サービスと Tunnel の自動起動とは別です。どちらもアプリを起動していなくても LaunchAgent で動きます）。
- ソースからビルドする方法は[開発](development.md)を参照してください。
