# 通知コアの実装範囲

通知コードを独立したTypeScriptライブラリとして追加しました。CLI・MCP入口には登録しておらず、イベント購読、timer、daemon、保存先の作成、実callback送信を自動開始しません。既存のstatus/sendは従来どおりです。

## コードと合成検証

| ファイル                | 実装                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/events/model.ts`   | host/worktree/pane/terminal/session/世代の全一致と、発生時のturn・transition識別子による絞り込み。復元状態、session境界、未確定終了は通知しない |
| `src/events/engine.ts`  | 所有者ごとの冪等な購読、callback確認、期限、解除、権限再検査、暗号化状態、outbox、重複抑制、上限付き再配送                                      |
| `src/events/webhook.ts` | HMAC署名、定数時間challenge比較、callback許可host、HTTPS、公開IPv4への接続固定、TLS hostname保持、redirect拒否、時間・応答量制限                |
| `src/events/auth.ts`    | 署名検証済みaccess tokenを受けるadapter契約。issuer/subject/audience/有効期限/scopeを検査し、所有者を導出                                       |
| `src/events/rpc.ts`     | `events/list`・`subscribe`・`unsubscribe`の独立handler。HTTP transportの認証を受け、RPC引数からownerを受け付けない                              |

`npm run verify`で既存テストと通知テストを実行します。通知テストは合成target、テスト専用鍵、メモリ内store、偽DNS・HTTPS接続だけを使います。署名は独立に計算した既知ベクトルと照合しました。実TLS handshakeや受信側署名検証器の試験ではありません。

検証範囲は署名の本文・時刻への束縛、challenge不一致・期限切れ、購読更新と所有者分離、暗号化状態からの新engine復旧、重複、鍵切替、期限・解除・権限失効、通知集中、保存失敗時の送信停止、順不同イベント、DNS再束縛、TLS hostnameと接続先IPの分離です。HTTP 2xxは受理だけを示し、dotの応答を意味しません。

## 運用上限と配送保証

- 購読は最大16、既定1時間、要求できる有限TTLは1秒〜24時間。無期限要求にも1時間を返します。
- callback確認のcacheは60秒で、更新のたびに期限を延長しません。鍵切替は60秒だけ新旧二重署名し、重複する切替を拒否します。
- outboxは購読ごと16・全体128件。重複記録は全体2048件まで保持し、上限時は新規受付のrejected件数を返します。重複記録を勝手に捨てて再送することはありません。上限監視と運用UIへの表示は未接続です。
- 再送は最大5回。送信前に試行回数を保存し、再起動でも同じeventId・本文を使います。署名時刻だけを更新します。410/413等の恒久的失敗では再送しません。
- 配信直後にprocessが停止した場合は再配送され得ます。exactly-once保証ではありません。保存の原子性・単一writer排他はstore adapterの責任です。
- AES-256-GCMで購読鍵・callback・outboxを暗号化します。テストは暗号化blobをメモリに保持してengineを再作成したもので、ディスク耐久性試験ではありません。実store、atomic rename/fsync、OS鍵保管、失効時の削除運用は未実装です。
- DNSは送信ごとに確認し、検証したIPをlookupに固定、元hostnameでTLS検証します。現在はIPv4限定で、IPv6を含むDNS回答は拒否します。HTTPSポートは443限定です。実callbackのhost許可listはまだありません。
- source replayは提供せず、cursorはnullです。Orca側で発生して取得できなかったイベントは復旧できません。終了・入力待ち以外のrawログや指示本文をpayloadに含めません。

## セッション対応付けの未接続部分

`projectObservation`が受け付けるのは、信頼できるsource adapterが**イベント発生時に**付けた完全な識別情報です。後からpaneを検索してsessionIdを補うと、pane再利用によって別セッションを通知する競合が生じます。raw Orca plugin payloadは必要情報がなく、この関数で拒否されます。

[Orca 1.4.220の端末契約](https://github.com/stablyai/orca/blob/v1.4.220/src/shared/runtime-terminal-contracts.ts)には、端末handle、recordedPaneKey、executionHostId、resolve/create側のincarnationIdがあります。しかし、それだけではイベント発生時のsession/turnを証明できません。[agent状態型](https://github.com/stablyai/orca/blob/v1.4.220/src/shared/agent-status-types.ts)にはsessionBoundaryもありますが、[plugin payload](https://github.com/stablyai/orca/blob/v1.4.220/src/shared/plugins/plugin-events.ts)には含まれません。したがって実source adapterは未実装で、識別子を推測して接続していません。

## 所有者認証の経路

候補は `ChatGPT → Secure MCP Tunnel → 認証付きローカルHTTP MCP → eventRpc` です。既存のstdio入口をこの経路へ変更していません。

[Secure MCP Tunnel公式資料](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#oauth)はOAuth discoveryの転送を説明していますが、認可serverを自動的に公開・転送する仕組みではありません。Tunnelのruntime API keyを購読所有者の認証tokenとして転用しません。HTTP側で署名・失効を検証し、期待issuer/audience/`orca:events` scopeを確認する必要があります。実issuer、client登録、署名検証器は未設定です。

## 実接続の前に必要な決定と承認

まだ監視対象が指定されていません。まず1セッションを確定し、source adapterが発生時の識別情報を提供できる契約を決める必要があります。Orcaの既存 `events:subscribe` はhost全体のイベント名購読なので、その権限の付与だけではこの不足を解消しません。

具体的な承認対象は、(1)選定したOrca source adapterとイベント読取範囲、(2)使用するOAuth issuer/clientと通知scope、(3)暗号化storeの保存先・保持期間・OS鍵管理、(4)ChatGPTが発行したcallback hostへの外向きHTTPS、(5)既存TunnelのHTTP upstream切替と切戻し手順です。未指定の対象やissuerを推測した包括承認は求めません。

承認質問を具体化するための不足情報は、**監視対象の1セッション**と、**利用する認可serverの有無・選択**です。source契約とこれらが確定してから、review可能な設定差分を作り、対象・権限・保存先・影響を示して承認を受けます。現時点で新credential、Orca plugin権限、ネットワーク設定、実保存先は追加していません。
