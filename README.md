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

顧客・物件・内見・案件は正規化した固定サンプルデータで、起動時に参照・日時・金額・enumの形状を検証します。スワイプ判定、Undo、表示順などの端末設定はバージョン付き `localStorage` に保存します。返信モックは営業の明示確認記録と本文指紋が一致した場合だけ端末内の送信記録へ進み、外部LINEへは送信しません。LINEログイン、永続DB、通知、ITANDI BBとの通信は未接続です。

## 後工程

1. LIFFのIDトークンをサーバー側で検証し、信頼できる権限情報に置き換える。
2. 画面が直接外部仕様に依存しないよう、ITANDI連携をAdapter層に切り出して接続する。

モデル、権限境界、工程9・10の品質ゲートは [`docs/architecture.md`](docs/architecture.md) を参照してください。
