# 依存ライセンスの確認範囲

## 現在の公開対象

Gitで追跡するソース・設定・lockfile・ドキュメントと、GitHub Releaseの配布物が対象です。`node_modules/`と`dist/`はgitignoreで除外しています。プロジェクトのMITは第三者コードのライセンスを変更しません。

ビルドはruntime依存を`dist/*.mjs`へ同梱します（`vite.config.ts`の`deps.alwaysBundle`）。同梱したパッケージはsource mapの`sources`から特定し、`scripts/bundled-licenses.mjs`がLICENSE（とNOTICEがあればその本文）を`dist/THIRD_PARTY_LICENSES.md`へ書き出します。ライセンス文書が見つからないパッケージがあるとビルドを失敗させます。2026年10月時点の同梱対象は10件（MIT・ISC・BSD-3-Clause・Apache-2.0。Apache-2.0の2件にNOTICEファイルはありません）です。

メニューバーアプリの配布物はElectronを含みます。`@electron/packager`が出力フォルダに置くElectronの`LICENSE`と`LICENSES.chromium.html`を、zipにそのまま含めています。

## MCP 2.0入口追加時の確認

公式server/client/core 2.3.1のpackage宣言とLICENSEを確認しました。serverはruntime、clientはtest用途です。MCP v2のLICENSEはApache-2.0と未移行MIT contributionsの説明を含みます。[通知本文](../THIRD_PARTY_NOTICES.md)を追加しました。以下の依存件数はv2追加前の監査記録であり、更新後lockfile全体の再監査を意味しません。

## v2追加前に確認した資料

package-lock.jsonの281依存エントリーにはライセンス宣言があります。現在の環境に存在する187パッケージのうち、174件でパッケージ直下のLICENSE・COPYING・NOTICE類を確認しました。合計176文書を走査し、直接依存の本文、runtimeのBSD条件、Apache-2.0・MPL-2.0の配布条項、ツールの同梱通知を確認しました。runtime扱いの94件すべてに本文ファイルがありました。これは宣言とインストール済み資料の確認であり、すべてのコードの権利関係を保証するものではありません。

| 直接依存                  | バージョン | 同梱資料                                          |
| ------------------------- | ---------- | ------------------------------------------------- |
| @modelcontextprotocol/sdk | 1.32.0     | LICENSE: MIT                                      |
| zod                       | 3.25.76    | LICENSE: MIT                                      |
| @types/node               | 22.19.15   | LICENSE: MIT                                      |
| typescript                | 5.9.3      | LICENSE.txt: Apache-2.0、ThirdPartyNoticeText.txt |
| vite-plus                 | 1.0.0      | LICENSE: 本体MIT、同梱依存MIT・ISC・BlueOak-1.0.0 |

runtimeの推移依存にはMIT・ISCのほか、fast-uriとqsのBSD-3-Clause、json-schema-typedのBSD-2-Clauseが含まれます。build依存のlightningcssと対応するネイティブパッケージにはMPL-2.0本文がありました。

## 依存やバイナリを同梱する場合

- 実際に配るOS・CPU・依存バージョンで通知を揃え、MIT・ISC・BSDの著作権・許諾・免責本文を保持してください。[直接依存の通知](../THIRD_PARTY_NOTICES.md)だけでは推移依存を網羅しません。
- TypeScriptなどApache-2.0のコードを配る場合、LICENSEと該当するNOTICE・著作権表記を保持し、変更したファイルがあれば変更を明示してください。TypeScriptのThirdPartyNoticeTextも削除しないでください。
- MPL-2.0の対象コードを実行形式で配る場合、対象ソースの提供方法を含めて確認してください。build時に利用していることと、そのコードを配布物へ含めることを区別します。
- Vite+のようなツール本体に同梱された依存は、lockfileのlicense欄だけでは網羅できません。ツールのLICENSE全体も保持してください。

## 未確認部分

94件の未インストールのoptional・他プラットフォーム依存は本文未確認です。また、次の13件はインストール済みですが、パッケージ直下に独立したライセンス文書が見つかりませんでした。すべてbuild/dev依存であり、親パッケージの通知や上流の該当バージョンと照合する前に、これらを含む配布物の通知が完全だとは扱いません。

- @oxfmt/binding-darwin-arm64
- @oxlint/binding-darwin-arm64
- @polka/url
- @rolldown/binding-darwin-arm64
- @voidzero-dev/vite-plus-darwin-arm64
- @yuku-codegen/binding-darwin-arm64
- @yuku-parser/binding-darwin-arm64
- @yuku-toolchain/types
- sirv
- stackback
- yuku-ast
- yuku-codegen
- yuku-parser

この記録は各確認時点のlockfileとローカル生成物の技術的な確認です。依存・対象プラットフォーム・配布形式の変更時は更新してください。
