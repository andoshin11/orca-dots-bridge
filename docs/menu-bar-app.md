# メニューバーアプリ

`setup`コマンドを画面から行う macOS のメニューバーアプリ（Electron）です。メニューバーに状態（`Orca ✓` / `Orca !` / `Orca ✕`）を表示し、状態確認用 Tunnel の稼働を30秒ごと、`setup doctor`相当の確認を10分ごとに行います。

[GitHub Releases](https://github.com/andoshin11/orca-dots-bridge/releases/latest) の`Orca-Dots-Bridge-<版>-mac-arm64.zip`（Intel Mac は`-mac-x64.zip`）を展開し、`Orca Dots Bridge.app`を「アプリケーション」へ移して開きます。bridge はアプリに同梱されていて、Node.js も clone も不要です。

- **初回の起動:** 開発者署名をしていないため、macOS が「“Orca Dots Bridge”は開いていません」と表示します。「完了」を押し、「システム設定」→「プライバシーとセキュリティ」に出る「このまま開く」を押します。確認のダイアログでもう一度「このまま開く」を選ぶと、Mac のログインパスワードを求められます（1回だけです）。
- **Finder で移してから開く:** ダウンロードしたアプリを Finder 以外の方法で移したり、ダウンロードフォルダのまま開いたりすると、macOS はアプリを一時的な場所で実行します（App Translocation）。その場合アプリは何も変更せず、「アプリケーション」へ移すよう案内して終了します（一時的な場所を Tunnel が参照すると、再起動後に動かなくなるためです）。
- **bridge の置き場所:** アプリは起動時に、同梱の bridge を`~/.orca-dots-bridge/runtime/<版>/`へコピーし、自身の Electron を Node.js の代わりとして`~/.orca-dots-bridge/runtime/node`にリンクします。状態確認用 Tunnel（LaunchAgent）はここを使うため、アプリを終了していても動きます。アプリを移動・更新したら、一度起動すれば張り直します。
- **更新:** 新しい版の zip で`Orca Dots Bridge.app`を置き換えて起動します。自動起動を入れていれば、状態確認用の profile も自動で新しい版に切り替わります。

- 画面の手順に沿って、Tunnel ID の貼り付け → runtime キーのコピー →「セットアップを実行」→ ChatGPT のプラグイン作成、と進めます。Platform・ChatGPT の該当ページはボタンで開けます。各手順には、押す場所に赤枠を付けた Platform・ChatGPT 画面のスクリーンショット（`app/images/`、ID などの識別子は塗りつぶし済み）を載せています。画像を押すと拡大します。
- runtime キーはクリップボードから main プロセスが直接読み、保存できたらクリップボードを空にします。画面（renderer）にはキーを渡しません。クリップボードの中身が runtime キーの形式でなければ、読み取りも消去もしません。
- 送信の許可などの設定は、このアプリではなくChatGPTのプラグイン管理画面で行います（[ChatGPT（dot）から使う](chatgpt-tunnel.md)の「指示の送信を許可」）。アプリが受け持つのは、Tunnelができる前の初回準備と、Tunnelが止まっていないかの表示です。
- 「ログイン時に起動」をオンにすると、アプリ自体もログイン時に起動します（状態確認用 Tunnel の自動起動とは別です。Tunnel はアプリを起動していなくても LaunchAgent で動きます）。
- ソースからビルドする方法は[開発](development.md)を参照してください。
