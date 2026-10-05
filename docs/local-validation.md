# ローカル検証

起動済みOrca runtimeと、同じコンピューターにインストールされたOrca CLIを使用します。

```sh
npm ci --ignore-scripts
npm run verify
npm run verify:local
```

`verify` は合成fixtureと偽CLIを使い、実Orcaに接続しません。`verify:local` は公式MCP SDKクライアントから次の経路を実際に呼びます。

```text
MCP SDK client → stdio bridge → Orca CLI → local runtime
```

initialize、tools/list、4種類のtools/call、概要のページング、判断待ち全ページ、個別詳細、最大2行・200文字のログを確認します。詳細の対象は最初の概要ページから最大5候補に限定します。対象がない場合は成功扱いせず、検証不能として終了します。

`ORCA_BIN` で実行ファイルを指定できます。リモートを誤って検証しないよう、子プロセスの `ORCA_ENVIRONMENT` と `ORCA_PAIRING_CODE` は空にします。

出力のfetchedAtは取得時刻です。複数ページは固定時点のsnapshotではありません。未評価のwait、古いagent観測、screen出力を、それぞれ「判断待ちなし」「停止」「履歴取得成功」に読み替えないでください。検証レポートにも運用情報が含まれ得るため、保存する場合はGit対象外の `.local/` を使ってください。CLI/MCPの生ログや実タスク情報をfixtureに転用しないでください。

## dotからの呼び出し

[公式のコンピューター接続](https://learn.chatgpt.com/docs/dots/computers-and-apps) は、接続済みコンピューター上のローカルタスクへの委任をサポートします。既存のローカルタスクに次のように依頼できます。

> このコンピューター上のorca-dots-bridgeでoverviewとwaitingを読み取り専用で実行し、取得時刻と未評価件数を添えて要約して。

[Voice](https://learn.chatgpt.com/docs/features/voice) はタスクへの委任と結果返却に対応します。MCPテストの成功は、dotへの直接登録や音声の往復成功を意味しません。

## 任意の直接MCP登録

[公式MCP設定](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) に従ってstdioサーバーを登録できます。[設定例](../examples/codex-mcp.toml) は未適用のテンプレートです。実際の絶対パスに置き換え、登録範囲とアクセス権限を確認してください。

ローカルMCP設定をクラウドのdotが自動継承するとは扱いません。コンピューターがオンラインで、既存の接続とOrca runtimeへのアクセスが有効であることが利用条件です。サンドボックスでEPERMになる場合は、その環境の承認手順を使ってください。検証スクリプトはセキュリティ設定や永続アクセスを変更しません。
