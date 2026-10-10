# 通知用 Tunnel の設定

自動通知（二段階試験）で、dot から bridge の購読入口 `http://127.0.0.1:8787/mcp` に届く経路を Secure MCP Tunnel で作る手順です。状態確認用の Tunnel（README の「Secure MCP Tunnel で status だけを公開する」）とは別の Tunnel にします。

## Tunnel は必要か

| 用途                 | Tunnel           | 理由                                                                                                                                                                                                |
| -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状態確認・指示の送信 | **不要にできる** | dot のローカルタスク（接続済みコンピューター）が `dist/cli.mjs` を実行する経路なら、外から Mac に入る経路を作らずに済みます。dot から直接ツールを呼びたいときだけ、状態確認用の Tunnel を使います。 |
| 自動通知             | **必要**         | MCP Events では、dot が bridge の入口に `events/subscribe` を送って購読を作ります。dot（クラウド）から Mac の `127.0.0.1:8787` に届く経路がないと、購読を作れません。                               |

自動通知の経路は Secure MCP Tunnel を勧めます。Tunnel クライアントは Mac から外へ接続するだけで、Mac でポートを開かず、インターネットに公開される URL も作りません。代わりの方法（Cloudflare Tunnel、Tailscale Funnel、ルーターのポート開放など）は、購読入口をインターネットに公開することになり、守りが Bearer トークンだけになるので勧めません。

### 最小の構成

- **状態確認:** Tunnel を使わず、dot のローカルタスク経由にします（直接呼びたい場合だけ、状態確認用の Tunnel を `ORCA_BRIDGE_STATUS_ONLY=1` で使う）。
- **自動通知:** 通知用の Tunnel を、**試験のあいだだけ**起動します。
- 二つの用途で Tunnel を共有しません（共有する構成は検証していません）。

## 認証の置き場所

bridge の購読入口は `Authorization: Bearer <API キー>`（Keychain の `service-v1` から作るもの）を要求します。この手順では、**Tunnel クライアントがこのヘッダーを付けます**（`mcp.extra_headers`）。dot のプラグインは「認証なし」で接続します。

- API キーは Mac から出ません。dot 側（クラウド）に保存されません。
- tunnel-client の資料（v0.0.15 `docs/configuration.md`「Static MCP headers」）によると、このヘッダーは設定した MCP サーバー（`127.0.0.1:8787`）にだけ送られ、OpenAI の制御用の通信には付きません。値は `file:` で参照でき、プロファイルに鍵を直接書かずに済みます。

dot のプラグイン側に API キーを登録し、Tunnel にそのまま転送させる方法もあります（tunnel-client は受け取った `Authorization` を転送します）。ただしその場合は、キーがクラウド側にも保存されます。

## 手順

手順 2 と 3（Bearer ファイルと profile）は、bridge の `setup` コマンドがまとめて行えます（README の「6. dotから直接statusを呼べるようにする」）。`--notification-tunnel-id '<通知用 Tunnel の ID>'` を付けて実行すると、`~/.orca-dots-bridge/tunnel/service-authorization` と `~/.orca-dots-bridge/tunnel/profiles/orca-notifications.yaml` を作ります。dot 用の API キーは表示せず、Keychain の `service-v1` から直接 Bearer ファイルに書くので、手順 2 の手入力は不要です。以下は手作業で行う場合の手順です。

### 1. 通知用の Tunnel を作る（初回だけ）

1. [公式の Secure MCP Tunnel ガイド](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)に従い、Platform で通知用の Tunnel を作り、個人の ChatGPT workspace に関連付けます。状態確認用とは別の Tunnel にします。
2. runtime 用の API キーを作ります。状態確認用と同じく、期限は短く（例: 1 日）、権限は Restricted の Tunnels Read + Use、それ以外は None にします。
3. tunnel-client は[公式の配布物](https://github.com/openai/tunnel-client/releases)を、チェックサムを確かめてから使います。この手順の設定項目は v0.0.15 の資料に基づいています。

### 2. Bearer ヘッダーの値をファイルにする（初回だけ）

`node dist/trial-key-setup.mjs` が表示した API キーを、所有者だけが読めるファイルに保存します。キーは画面にもコマンド引数にも出しません。

```zsh
mkdir -m 700 -p ~/.orca-dots-bridge/tunnel
(
  umask 077
  read -rs 'key?dot プラグインの API キー (hidden): '
  print
  [[ -n "$key" ]] || exit 1
  printf 'Bearer %s' "$key" > ~/.orca-dots-bridge/tunnel/service-authorization
)
```

このファイルは Git の管理外に置き、チャットにも貼らないでください。

### 3. プロファイルを作る（初回だけ）

HTTP の MCP サーバーへ転送する公式サンプル（`sample_mcp_remote_no_auth`）から作ります。

```sh
tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile orca-notifications \
  --tunnel-id '<通知用 Tunnel の ID>' \
  --mcp-server-url 'http://127.0.0.1:8787/mcp' \
  --health-listen-addr '127.0.0.1:0'
```

作成されたプロファイルの `mcp` に `extra_headers` を足します（`<ホーム>` は実際のパスに置き換えます）。

```yaml
mcp:
  server_urls:
    - channel: main
      url: "http://127.0.0.1:8787/mcp"
  extra_headers:
    Authorization: file:<ホーム>/.orca-dots-bridge/tunnel/service-authorization
```

- 転送先は必ず `http://127.0.0.1:8787/mcp` にします。bridge は `Host: 127.0.0.1:8787` 以外の要求を拒否します。
- relay plugin 用のポート（`relayPort`）には向けないでください。
- `control_plane.api_key` は `env:CONTROL_PLANE_API_KEY` のまま（キーを書き込まない）にします。

### 4. 試験のたびに起動する

試験の期限は最長 10 分なので、次を続けて行います。

1. **bridge の二段階試験を先に起動します**（[relay plugin による通知](relay-notifications.md)の手順 5）。Tunnel クライアントは起動時に転送先へ接続を確かめるので、購読入口が待ち受けている必要があります。
2. **通知用の Tunnel を起動します。** runtime 用の API キーは、状態確認用の手順と同じく非表示で入力し、サブシェルを抜けると消えるようにします。

   ```zsh
   (
     set +x
     read -rs 'CONTROL_PLANE_API_KEY?Runtime API key (hidden): '
     print
     [[ -n "$CONTROL_PLANE_API_KEY" ]] || exit 1
     export CONTROL_PLANE_API_KEY
     tunnel-client run --profile-file '<手順 3 のプロファイル>' > /dev/null 2>&1
   )
   ```

3. **dot 側で接続します（初回だけ）。** ChatGPT のプラグイン追加から「カスタム MCP サーバーを作成」を開き、接続タイプ「トンネル」で通知用の Tunnel を指定し、認証は「認証なし」にします。
4. **dot 側で購読します。** イベント名は `orca.pane_activity`、`arguments` は `pane-target` で取った `target` です。

### 5. つながったかを確かめる

bridge の診断（`counts.json`）で次を確かめます。

| 診断                              | 意味                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| `mcp_arrived` が増える            | Tunnel から購読入口に届いている                                      |
| `auth_accepted` が増える          | Bearer が正しい                                                      |
| `auth_rejected` が増える          | Bearer が違う。手順 2 のファイルの中身（`Bearer ` の後ろ）を確かめる |
| `http_boundary_rejected` が増える | 転送先の URL が `http://127.0.0.1:8787/mcp` になっていない           |
| `subscription_created` が増える   | 購読ができ、確認通信が成功した                                       |

### 6. 終了

試験は期限で自動的に終わります。Tunnel クライアントは `Ctrl+C` で止めます。試験が終わると購読入口も閉じるので、Tunnel を動かしたままにしておく意味はありません。

## 検証の状況

- 状態確認用の Tunnel（stdio、v0.0.15）で、dot から `orca_status` を直接呼べることは検証済みです（README）。
- 2026-10-08 の試験では、Tunnel 経由で購読入口に届き、購読の作成と通知の送信まで成功しています。ただし、そのとき Bearer をどちらの方法で付けたかは記録に残っていません。
- **この手順の `mcp.extra_headers` による構成は、tunnel-client v0.0.15 の資料とソースで確かめたもので、まだ実際には動かしていません。** `Authorization` は MCP 転送先へのヘッダーとして予約されておらず、そのまま設定されることをソースで確認しています。
