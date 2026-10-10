# 開発

Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`、npm、Orca CLI と起動済み runtime が必要です。

```sh
npm ci --ignore-scripts
npm run verify
node dist/cli.mjs overview --limit 5
```

Vite+ **1.0.0** をプロジェクト内に固定し、lockfile を同梱しています。グローバルの vp / Node 設定は変更しません。

| 用途                       | コマンド                               |
| -------------------------- | -------------------------------------- |
| ビルド                     | `npm run build` → `vp pack`            |
| lint・format・型検査       | `npm run check` → `vp check`           |
| lint のみ                  | `npm run lint` → `vp lint`             |
| format                     | `npm run format` → `vp fmt`            |
| format 検査                | `npm run format:check`                 |
| テスト                     | `npm test` → `vp test` (Vitest)        |
| 独立した TypeScript 型検査 | `npm run typecheck`                    |
| 全検証タスク               | `npm run verify` → `vp run verify-all` |

## リリース

`package.json`の`version`を上げてmainへマージし、同じ版のタグ（例: `v0.2.0`）をpushします。GitHub Actions（`.github/workflows/release.yml`）が検証のうえ、次をGitHub Releaseに置きます。

- `orca-dots-bridge-<版>.tar.gz`: 依存を同梱した`dist`（CLI・MCP・setup）。`dist/THIRD_PARTY_LICENSES.md`付き
- `Orca-Dots-Bridge-<版>-mac-arm64.zip` / `-mac-x64.zip`: bridgeを同梱したメニューバーアプリ（アドホック署名）
- `SHA256SUMS`

PRとmainへのpushでは`.github/workflows/ci.yml`が`npm run verify`をNode 22・24で実行します。

## メニューバーアプリをソースから作る

```sh
npm run build
cd app
npm ci
npm run package              # このcheckoutを参照するアプリ（開発用）
npm run package -- --bundle  # bridgeを同梱するアプリ（リリースと同じ形）
```

開発中は`cd app && npm start`でも起動できます。

## ビルドについて

Node CLI / MCP のビルドなので Vite+ の `vp pack` を使用します。`vp build` はWebアプリ用です。設定は `vite.config.ts` にまとめ、検証タスクのキャッシュは無効にしています。
