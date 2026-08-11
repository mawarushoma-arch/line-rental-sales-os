# 賃貸営業OS 技術仕様

> 状態: 実装済みなのはモックUIとAPI/Adapter骨格。本文は、モックで固定する画面契約と、本番接続で満たす境界を定義する。

## 1. 利用者・チャネル・信頼境界

```text
顧客 ── 公式LINEトーク ── 返信下書き/承認済み返信

営業 ── LINE内LIFF ── API/BFF ── 正規化モデル ── ITANDI Adapter ── ITANDI API
                         │                              └─ ITANDI BB認証済み遷移
                         └─ 権限・監査・AI承認・送信制御
```

- **顧客の接点は公式LINEのトークだけ**とする。顧客向けLIFF業務画面は提供しない。
- **営業画面は承認済みLINE IDの社員だけ**がLIFFから利用できる。LIFF起動時に取得したID tokenをサーバーで検証し、さらに全API要求で毎回、社員allowlist、role、在籍/失効状態を確認する。画面側の表示制御は権限判定の正本にしない。
- URL、クエリ文字列、localStorageの値は本人性を証明しない。コピー/転送したURLだけでは開けず、LINE外ブラウザ、未承認ID、失効IDはデータを返す前に拒否する。URLへLINE user IDや権限を埋め込まない。
- LINE ID token、生のLINE user ID、ITANDI認証情報はブラウザ永続領域へ保存しない。

## 2. UI正規化モデル

すべての`id`は不透明な文字列、`...Id`は別モデルへの参照、日時はタイムゾーン付きISO 8601、金額は円の整数とする。表示用の結合データはセレクタ/ViewModelで作り、同じ事実を複数モデルへ重複保存しない。

| モデル | 主要フィールド | 意味・制約 |
|---|---|---|
| `Customer` | `id`, `name`, `kana`, `assignedTo`, `unassigned`, `priority`, `lastContactAt`, `source`, `status`, `lineSummary`, `progress`, `searchConditionId`, `lineUserId` | `lineUserId`はサーバー限定。`status`は通常遷移 `新規` → `条件確認中` → `物件提案中` → `内見調整中` → `内見待ち` → `書類待ち` → `申込済` → `審査中` → `契約準備` → `契約済`、分岐状態は`保留`/`失注`。モックの表示名`stage`はこの`status`へ対応付ける。 |
| `SearchCondition` | `id`, `customerId`, `items[]`, `updatedAt` | `items[] = { key, label, value, status, sourceRef?, checkedAt? }`。`status`は`confirmed`（確定）/`inferred`（推定）/`unknown`（未確認）。エリア、賃料、間取り等を同じ形式で扱う。 |
| `Property` | `id`, `itandiPropertyId`, `name`, `imageUrl`, `listedAt`, `sourceUpdatedAt?`, `fetchedAt`, `rentYen`, `managementFeeYen`, `address`, `viewingAvailable`, `moveInAt`, `initialCostYen`, `publicNote`, `internal` | 物件そのものの事実。`internal = { ad, keyInfo, managementCompanyNote }`は営業限定で、顧客返信用DTOへ含めない。顧客別の評価は持たせない。 |
| `CandidateProperty` | `id`, `customerId`, `propertyId`, `status`, `matchScore`, `matchReasons[]`, `createdAt`, `updatedAt` | 顧客と物件の関連。`status`は`unreviewed`/`liked`/`skipped`/`reserved`。`matchScore`と理由は顧客別なので`Property`ではなくここに置く。 |
| `Viewing` | `id`, `customerId`, `propertyId`, `date`, `time`, `range`, `meetingPlace`, `vacancyConfirmed`, `keyConfirmed`, `keyNote`, `routeOrder`, `status`, `impression`, `temperature`, `nextAction` | `range`は`today`/`week`。空室・鍵確認の状態と、顧客へ見せない`keyNote`を分離する。日時確定前は未確認として表示する。 |
| `Case` | `id`, `customerId`, `propertyId?`, `stage`, `nextAction`, `dueAt`, `documentStatus`, `applicationStatus`, `updatedAt` | 営業案件の進行単位。`stage`は`追客中`/`内見調整`/`申込準備`/`審査中`/`契約準備`。顧客全体の`Customer.status`とは別に、個別案件の進行を表す。 |
| `TodayAction` | `id`, `kind`, `title`, `customerId`, `caseId?`, `dueAt`, `urgency`, `action`, `status` | 当日キュー。`kind`は`priority`/`deadline`、`status`は`todo`/`done`。元データを変更せず、案件・期限から派生できる。 |
| `DisplayPreference` | `salesUserId`, `widgets[]`, `propertyFields[]`, `updatedAt` | `salesUserId`はサーバーが認証結果から設定する。`widgets[]`と`propertyFields[]`は表示順・表示有無。業務データや権限は保持しない。 |

モックでは`CandidateProperty.status`の`liked`/`skipped`と`DisplayPreference`をlocalStorage v2で上書き・派生してよい。seed状態より営業の端末操作を優先し、Undo時は直前状態へ厳密に戻す。ただし本番ではlocalStorageを正本にせず、承認済み営業IDに紐づくサーバー状態へ移す。

実装済みモックは起動時に8モデルの必須形状、参照ID、ISO日時、円整数、enumを検査する。Workerの`/api/mock/bootstrap`もモデル名だけでなく主要フィールド契約を返し、開発サーバーと同じ定義を共有する。

## 3. ITANDI Adapter境界

- **契約済みのITANDI API仕様書を唯一の正本**とする。エンドポイント、項目、enum、null可否、更新可否、権限、レート制限、エラーを推測で補わない。ベンダー固有のレスポンスはAdapter内で上記モデルへ変換し、UIへ直接露出させない。
- APIで更新できない操作は成功したように見せず、操作種別と対象IDを渡して**ITANDI BBの認証済み画面へ遷移**する。遷移URL自体を認証手段にはせず、ITANDI側でも認証を要求する。
- Adapterは取得時刻を`fetchedAt`、仕様書にあるデータ更新時刻を`sourceUpdatedAt`として返す。更新時刻が提供されない場合は未確認のままにし、取得時刻で代用しない。欠損、期限超過、API障害を空文字や「確認済み」へ変換しない。
- 顧客返信生成へ渡す物件データは許可リスト方式にする。`ad`、鍵情報/鍵備考、管理会社備考を含む`Property.internal`と`Viewing.keyNote`は、プロンプトで隠すのではなく送信前のDTO生成段階で除外する。

## 4. AIと顧客送信

- AIが扱う事実には`confirmed`（確定）/`inferred`（推定）/`unknown`（未確認）を保持し、画面と返信下書きで区別する。根拠がない値を確定へ昇格させない。
- 値の優先順位は **営業担当者の修正 > 契約APIで確認した値 > AI推定**。営業修正は上書き前後、担当者、時刻、根拠を監査ログへ残す。
- AIは返信の**下書き**までとする。営業の明示承認後だけ送信可能とし、送信APIも承認状態、承認者、承認後の本文未変更を再確認する。承認なしの自動送信、バックグラウンド送信、AI判断だけの再送は禁止する。
- モックでは「確認して送信」の操作時にだけ承認記録を作り、draft IDと本文指紋が一致する許可リストDTOだけを端末内Gatewayへ渡す。これは実送信・本人認証の代替ではなく、工程10では承認記録、承認者、本文指紋、冪等キーをサーバー正本へ移す。

## 5. モックと後工程の境界

| 段階 | 対象 | 完了条件 |
|---|---|---|
| 現在 | モックUI | 画面構成、状態表示、スワイプ、Undo、空状態、ロール拒否表示を固定する。データはモック/localStorageで、LINE認証、永続API、ITANDI接続、実AI、実送信は未実装。 |
| **工程9** | 仕様書項目対応 | 契約済みITANDI API仕様書の全項目を正規化モデルへ対応付け、更新可否、認証済み遷移、欠損/エラー/鮮度の扱いを確定する。 |
| **工程10** | 実接続試験 | 検証環境と認証情報を安全に受領し、許可された実データで認証、取得、遷移、権限拒否、返信承認、監査をE2E試験する。秘密情報はリポジトリへ保存しない。 |

工程9と工程10は別の品質ゲートとして計画に保持する。モック完成を理由に削除、前倒し完了、または一工程へ統合しない。

## 6. 本番化チェックリスト

- [ ] LIFF ID tokenをサーバーで検証し、発行先、有効期限、署名/nonce等の検証失敗をfail closedにする。
- [ ] 全APIで社員allowlistとroleを再確認し、顧客横断閲覧、更新、送信の権限を分離する。
- [ ] 退職・異動・端末紛失時に権限とセッションを即時失効でき、キャッシュ済み画面からも再利用できない。
- [ ] 閲覧、検索、修正、承認、送信、ITANDI遷移、拒否を、担当者・対象・結果・request ID・時刻付きで監査記録する。
- [ ] 変更系要求に短寿命の署名付きstate/nonce、Origin検証、SameSite Cookie等のCSRF相当対策を適用し、送信には冪等キーを付ける。
- [ ] LINE/ITANDI呼び出しにタイムアウトを設ける。再試行は指数バックオフし、安全な取得または冪等な操作だけに限定する。
- [ ] `sourceUpdatedAt`が不明、または`fetchedAt`/`sourceUpdatedAt`が基準超過なら鮮度警告を出し、空室・鍵・金額等は重要操作前に再確認する。
- [ ] 個人情報ログ抑制を適用し、token、生LINE ID、顧客本文、鍵情報、管理会社備考等を通常ログへ出さない。必要な監査値は代理ID化・マスキングし、保持期間と閲覧権限を設定する。

## 7. UI・セキュリティ受入試験

| 試験 | 合格条件 |
|---|---|
| 幅360 / 390 / 430 px | 横スクロール、切れ、操作不能がなく、主要操作が片手で到達できる。 |
| LINE iOS / Android | LIFF起動、戻る、再開、キーボード表示後も状態とレイアウトが壊れない。 |
| ライト / ダーク | 文字、状態ラベル、ボタン、フォーカスのコントラストと意味が保たれる。 |
| 候補物件を20回連続スワイプ | 二重処理、カード飛び、選択混線、著しい遅延がなく、順序と結果が一致する。 |
| Undo | 直前のスワイプ結果だけを一度復元し、画面・保存状態・件数が一致する。 |
| 顧客未選択 | 顧客依存データを表示せず、更新/送信を無効化し、別顧客の状態を流用しない。 |
| role拒否 | UIを隠すだけでなくAPIが拒否し、データ本文を返さず、監査ログへ残る。 |
| 転送URL/失効ID | ロード前またはデータ取得前に拒否し、URLだけでは復旧できない。 |
| AI未承認 | 送信APIが拒否し、公式LINEへの送信呼び出しが0件である。 |

自動試験は20件の判断/Undo、顧客分離、Adapterのtimeout・auth・contract分類、未承認返信拒否、Worker契約を検証する。`tests/browser-smoke.mjs`はChrome CDPで360/390/430px、5画面遷移、role拒否、Like/Skip/Undo、表示設定、stale/empty/error、明示送信前0件を検証し、Chromeを起動できない管理環境では理由付きSKIPとする。LINE iOS/Android実機試験は制作順序7の品質ゲートとして残す。
