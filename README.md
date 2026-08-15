# ROOM PILOT — LINE賃貸営業OS

LINE内で「顧客・物件・今日・内見・案件」を素早く切り替える、モバイル向け賃貸営業OSの静的モックです。Node.jsの標準APIだけで起動・ビルド・テストでき、npm依存パッケージはありません。

## ローカル起動

Node.js 22.13以上を使用します。

```bash
npm run dev
```

`http://127.0.0.1:4173/` を開いてください。`PORT` と `HOST` で待ち受け先を変更できます。

```bash
npm run lint
npm test
npm run build
npm run test:browser
```

`npm run build` は `public/` を `dist/client/` へ再帰的にコピーし、Cloudflare Worker互換の `dist/server/index.js` を生成します。

### LINE連携前のUI確認

ローカルサーバーを立ち上げずに確認する場合は、次を一度実行して `dist/room-pilot-preview.html` をブラウザで開いてください。ファイルで開いた場合だけ、社員モックとモックAPIを自動で使います。

```bash
npm run preview:file
```

通常のWebサーバーで確認する場合は `npm run dev` 後に `http://127.0.0.1:4173/?role=employee` を開きます。どちらもLINE認証、外部LINE送信、ITANDI BB通信は行いません。

`npm test` はWorker/API/状態遷移のテストに加えて、依存ゼロのChrome CDP統合テストも呼び出します。Chromeを起動できない管理環境では統合テストだけが理由付きでSKIPされます。実機に近い確認では `BROWSER_SMOKE_STRICT=1 npm run test:browser` を実行すると、起動不可も失敗として扱えます。

## 公式LINE実機テスト（`/line`）

モックとは別に、**本物の公式アカウントと送受信する画面**を `/line` に用意しています。SPA（`public/app.js`）とは切り離してあり、モックのデータには一切触れません。

- 受信：`POST /line/webhook` が `X-Line-Signature` をチャネルシークレットで検証してから保存する。検証に失敗した本文は読まずに捨てる。`webhookEventId` で冪等化する。
- 送信：`POST /api/line/send`。営業の確認記録（`confirmed` / `draftId` / `approvedBy` / `approvedAt`）と本文指紋が揃い、**サーバーが本文から作り直した指紋と一致したときだけ** Messaging API を呼ぶ。確認から10分を過ぎた本文は送らない。
- 受信直後（約50秒以内）は無料の**応答メッセージ**、過ぎていれば**プッシュ送信**へ自動で切り替える。プッシュはフリープランで月200通なので、画面に残数を出している。
- 送信失敗は成功へ丸めず `failed` として残す。再送は営業がもう一度確認したときだけ。
- 生のLINE user ID と `replyToken` は画面へ返さない。画面が扱うのはチャネルシークレットで導出した不可逆な `threadId` だけ。

保存先は KV（binding `LINE_STORE`）。画面は `x-room-pilot-key` ヘッダーの合言葉で保護する。

### 必要な設定

シークレットは3つ。**`wrangler.toml` へ書かず**、暗号化シークレットとして登録する（このリポジトリは公開）。

```bash
wrangler secret put LINE_CHANNEL_SECRET        # LINE Developers > チャネル基本設定
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN  # 同 > Messaging API設定（長期）
wrangler secret put ROOM_PILOT_LINE_KEY        # この画面を開くための合言葉（任意の文字列）
```

Webhookの宛先は Messaging API から登録できる。

```bash
curl -X PUT https://api.line.me/v2/bot/channel/webhook/endpoint \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"endpoint":"https://<デプロイ先>/line/webhook"}'
```

**Webhookの利用ON／応答メッセージOFF は APIから変えられない**ため、[LINE Official Account Manager](https://manager.line.biz/) の「設定 > 応答設定」で切り替える。ONになっているかは `GET /v2/bot/channel/webhook/endpoint` の `active` で確認できる。

ローカルで試す場合は `.dev.vars`（gitignore済み）に同じ4項目を書くと `npm run dev` でも同じ経路が動く。ただし保存はプロセス内メモリで、Webhookは外部から届かない。

### AIによる要約と条件整理

`POST /api/line/analyze` が、保存済みの会話から**要約**と**希望条件**を作る。モデルはCloudflare Workers AIの `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（binding `AI`）で、**会話はCloudflareの外へ出ない**。追加のAPIキーは要らない。

`docs/architecture.md` 4章の約束をここで守っている。

- AIが埋めた値は必ず `inferred`（推定）。`confirmed` へ昇格させる経路はない。
- **各項目に、根拠になった顧客の発言をそのまま `quote` として持たせる。** 引用が無い値は採用せず `unknown` にする。値だけそれらしく埋まる状態を作らない。
- 読み取れない項目は「まだ確認できていません」として残し、空欄を推測で埋めない。

構造化出力（`response_format: json_schema`）を使うため、返答は文字列ではなく**オブジェクト**で返る。指定が効かない場合に備えて文字列のJSON抽出も残してある。所要はおよそ5〜10秒。

### LIFF（LINEアプリ内で全画面表示）

LIFFアプリは**LINEログインチャネル**にしか作れない。Messaging APIチャネルの access token で `POST /liff/v1/apps` を叩くと `Channel must have any of following Application Types` で断られる。

**LIFFはクエリとパスを `liff.state` に畳んで渡す。** `https://liff.line.me/{liffId}?role=employee` は `https://<エンドポイント>/?liff.state=%3Frole%3Demployee` として開くため、そのままでは `role` が読めずアクセス制限画面になる。`public/app.js` の `expandLiffState` が読み込み前に展開しており、LIFF SDKは使っていない。パスが違う場合だけ `location.replace` する。

### リッチメニュー

トーク下部の常設ボタン。画像は2500×1686・JPEG・**1MB以下**が上限で、全面を1つのタップ領域にして営業画面へ送っている。

```bash
# 作成 → 画像アップロード → 紐づけ、の3手順
curl -X POST https://api.line.me/v2/bot/richmenu -H "Authorization: Bearer $TOKEN" ...
curl -X POST https://api-data.line.me/v2/bot/richmenu/$ID/content -H 'content-type: image/jpeg' --data-binary @richmenu.jpg ...
curl -X POST https://api.line.me/v2/bot/user/$USER_ID/richmenu/$ID   # 特定の人だけ
curl -X POST https://api.line.me/v2/bot/user/all/richmenu/$ID        # 友だち全員（既定）
```

**特定の人へ紐づけている間は、その人にだけ表示される。** 既定を設定するまで他の友だちには出ない。外すときは `DELETE /v2/bot/user/{userId}/richmenu`、既定は `DELETE /v2/bot/user/all/richmenu`。

ヘッダーのロゴは `public/brand/header.png`。元データの透明な余白を落として高さ96pxで書き出したもので、表示は高さ24〜30px。

## 配色

デザインカンプに合わせた全画面ライトで統一しています（背景 `#FFFFFF`、沈める面は `#FAFAFA`）。

- **アクセント（操作）＝グリーン `#00AB42`**。主要ボタン、現在地、保存、選択中のチップだけに使います。
- **確認済み・完了・確定＝ブルー `#0B4CB4`**。アクセントに緑を使うため、状態の緑を青へ逃がしています。空室再確認や鍵確認の「確認済み」もこの青です。
- 期限注意＝オレンジ `#D2560A`、期限超過・募集終了＝レッド `#EE2020`、未確認・情報不足＝グレー `#757B87`。

**緑は操作、青は確認済み**という切り分けを崩さないでください。状態表現に緑を戻すと、押せるものと済んだものが同じ色になります。

## 権限表示の確認

現在はURLの `role` クエリでモック表示を切り替えます。

- `/?role=employee`: 社内メンバー用の営業画面
- `/?role=pending`: 権限申請中の案内
- `/?role=customer`: 社外ユーザー向けのアクセス制限

`role` 未指定時もアクセス制限画面を表示します。`role` は画面確認用であり、本番の認証・認可には使えません。

## 通信状態の確認

モックAdapterは `api` クエリで、API接続後に必要となる回復UIを再現できます。

- `/?role=employee&api=loading`: Skeletonを長めに表示してから読み込み
- `/?role=employee&api=stale`: 情報鮮度の警告
- `/?role=employee&api=empty`: 検索0件と条件見直し
- `/?role=employee&api=error`: 通信失敗と再試行
- `/?role=employee&api=timeout`: タイムアウトと再試行

Workerの `/api/health` と `/api/mock/bootstrap` は、実接続前のAPI契約確認用です。

## モックの範囲

顧客・物件・内見・案件は正規化した固定サンプルデータで、起動時に参照・日時・金額・enumの形状を検証します。スワイプ判定、Undo、表示順などの端末設定はバージョン付き `localStorage` に保存します。

物件の仕分けデッキは、**左右スワイプで前後の候補へ送り（判断しない）、下スワイプで候補へ保存**します。Skipは取り消しにくいためジェスチャーに割り当てず、カード左下のボタンに置いています。カード表面は物件名・賃料・間取り・募集状況・駅徒歩・一致率・鮮度だけにして、残りの項目はカードをタップした詳細シートで確認します。判断のUndoは8秒間有効です。

保存した物件は画面下端にカードとして積み上がり、束をタップすると保存済み一覧を開きます。カードの操作部（スキップ・保存）まで1画面に収めるため、この画面には提案の進み具合のような補助表示を置きません。ヘッダーの並び替えは「マッチ度順／家賃が安い順／AD高い順／新着順」の4軸で、家賃は管理費込みで比較します。虫めがねのチップから、募集終了・内見可否・鮮度の絞り込みを掛けられます。並び替えと絞り込みは端末に保存せず、画面を離れると既定へ戻ります。返信モックは営業の明示確認記録と本文指紋が一致した場合だけ端末内の送信記録へ進み、外部LINEへは送信しません。LINEログイン、永続DB、通知、ITANDI BBとの通信は未接続です。

## 後工程

1. LIFFのIDトークンをサーバー側で検証し、信頼できる権限情報に置き換える。
2. 画面が直接外部仕様に依存しないよう、ITANDI連携をAdapter層に切り出して接続する。

モデル、権限境界、工程9・10の品質ゲートは [`docs/architecture.md`](docs/architecture.md) を参照してください。
