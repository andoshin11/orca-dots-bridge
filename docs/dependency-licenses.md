# 依存ライセンスの確認範囲

## 現在の公開対象

Gitで追跡するソース・設定・lockfile・ドキュメントが対象です。`node_modules/`と`dist/`はgitignoreで除外しています。依存パッケージやツールチェーンのバイナリを含む配布物は、この確認の公開対象に含めません。プロジェクトのMITは第三者コードのライセンスを変更しません。

現行のVite+ pack出力のimportとsource mapを確認しました。MCP SDKとZodは外部importのままで、mapのsourcesはすべて`src/`のプロジェクトファイルでした。現在の生成物には依存実装の取り込みは確認されていません。バンドル設定を変えた場合は再確認してください。

## 実際に確認した資料

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

この記録は現行lockfileとローカル生成物の技術的な確認です。依存・対象プラットフォーム・配布形式の変更時は更新してください。
