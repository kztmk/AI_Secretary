# 秘書アプリ 仕様書 v4
## GAS + Firebase + RAG 構成

---

## v3からの主な変更点

| # | 変更 | 理由 |
|---|------|------|
| 1 | Gmail下書きの保存をCloud Functions → **GAS** に移管 | FunctionsのサービスアカウントはユーザーのGmailにアクセスできない（ドメイン委任 or リフレッシュトークン保管が必要になり構築・運用コストが高い） |
| 2 | Firestoreセキュリティルールを「認証済みなら可」から**管理者限定＋フィールドレベル制御**に変更 | Googleログインは誰でも可能なため「認証済み=管理者」ではない |
| 3 | Cloud Functionsトリガーの**冪等性対策**（statusの排他遷移）を明記 | Firestoreトリガーはat-least-once配信で二重実行があり得る |
| 4 | `chatQueue` に **sessionId** を追加しマルチターン会話に対応 | 会話履歴をClaudeに渡す前提とスキーマが矛盾していた |
| 5 | `emails`・`reports` のドキュメントIDを**決定的**に（GmailのmessageId / 日付ID）変更 | 巡回の重複実行でもupsertで冪等になる |
| 6 | 未読ベースの巡回を**処理済みラベル方式**に変更 | 既読化のタイミングに依存せず重複・取りこぼしを防ぐ |
| 7 | セクション8（Cloud Functions構成）を記載（v3では空だった） | — |
| 8 | GAS→Firestore書き込みサンプルを修正（timestamp対応・integerValueの文字列化・updateMask・oauthScopes） | v3のサンプルはそのままでは動かない |
| 9 | ベクトルインデックスは `firestore.indexes.json` ではなく **gcloud CLI** で作成する旨を明記 | `firebase deploy` の対象外 |
| 10 | Embeddingモデルを `gemini-embedding-001` に変更（実装時に最新推奨を再確認） | text-embedding-004 は旧世代化 |
| 11 | Blazeプラン必須・プライバシー上の注意を追記 | — |

### v4.1 追記（2026-06-11）

- GASワークスペースを **TypeScript + Vite + @gas-plugin/unplugin** 構成に変更（セクション3・7）。`dist/Code.js` にバンドルして clasp push する
- 設定値（FirebaseプロジェクトID等）はコードに書かず **Script Properties**（PropertiesService）で管理する方針を明記（セクション9・11）。GAS実行環境に `.env` は存在しない
- `.clasp.json` は `scriptId` を含むため gitignore し、`.clasp.json.example` をリポジトリに置く

---

## 1. システム概要

管理者向けのAI秘書アプリ。GASがGmailへ定時アクセスしメールを分類・集計してFirestoreに保存。Claude APIの呼び出しはCloud Functionsが担い、返信下書きの**本文生成**と管理者チャットに特化する。生成された下書き本文はFirestore経由でGASが受け取り、GAS側でGmailの下書きとして保存する（Gmailへの書き込みはすべてGASに集約）。返信下書き・チャット応答の際は、DocusaurusのマニュアルとWordPressのブログをRAG（検索拡張生成）で参照し、正確な情報に基づいた回答を生成する。

---

## 2. システム構成

```
[Docusaurus マニュアル]  [WordPress ブログ]
   Markdownファイル         REST API
         ↓ 定期バッチ（Cloud Functions）
    テキスト抽出・チャンク分割・ベクトル化
         ↓
   Firestore Vector Search（ベクトルDB）
         ↑ 類似検索
[Gmail]
   ↕ 定時アクセス（GASトリガー）
[GAS]
   ├── メール取得・分類・集計 → Firestore に書き込み（REST API）
   └── 下書き本文の受け取り ←─ Firestore（draftStatus: "ready" を巡回）
         └→ GmailApp.createDraft() で下書き保存 → gmailDraftId を書き戻し
                        ↓ Firestoreドキュメント作成トリガー
                  [Cloud Functions]
                     ├── RAG検索（関連チャンク取得）
                     └── Claude API 呼び出し（コンテキスト注入）
                           ├── 返信下書き本文 → Firestoreに書き戻し（draftStatus: "ready"）
                           └── チャット応答   → Firestoreに書き戻し
                                    ↓ リアルタイム購読
                           [React フロント / Firebase Hosting]
                              ├── 秘書キャラクター＋レポートダッシュボード
                              └── チャットUI（質問を chatQueue に投入）
```

**ポイント**: Gmailへの読み書きはGASのみ・Claude/Vertex AIの呼び出しはFunctionsのみ・両者の受け渡しはすべてFirestoreを介す。認証経路がそれぞれのプラットフォームで完結する。

---

## 3. 技術選定

### GAS（Google Apps Script）

| 項目 | 内容 |
|------|------|
| 役割 | Gmail定時巡回・メール分類・集計・Firestore書き込み・**下書き保存** |
| 定時実行 | 時間ベーストリガー（巡回: 1日4回 / 下書き反映: 15分間隔の軽量トリガー） |
| Gmail連携 | GmailApp クラス |
| Firestore連携 | UrlFetchApp で Firestore REST API を呼び出し |
| 実行時間制限 | 6分／回（1回の処理件数に上限を設ける。セクション14参照） |
| 開発言語・ビルド | TypeScript + Vite + **@gas-plugin/unplugin**（`dist/Code.js` にバンドルして clasp push。export除去・トリガー関数のtree-shaking保護・appsscript.jsonコピーをプラグインが担う） |
| 設定管理 | **Script Properties**（PropertiesService）。GAS実行環境に `.env` は存在しないため使わない |

### Firebase

| サービス | 用途 |
|----------|------|
| Firestore | GAS・Functions・フロントの共有データストア |
| Firestore Vector Search | RAG用ベクトルDB |
| Cloud Functions（第2世代） | RAGバッチ・Claude API呼び出し（Firestoreトリガー） |
| Firebase Hosting | Reactフロントのホスティング |
| Firebase Auth | 管理者認証（Googleログイン＋管理者判定） |

> **注意**: Firestoreトリガー付きCloud Functionsの利用には **Blazeプラン（従量課金）への登録が必須**。無料枠の範囲内でも支払い方法の登録が必要。

### RAG

| 項目 | 採用技術 | 理由 |
|------|----------|------|
| ベクトルDB | Firestore Vector Search | Firebase内で完結・追加サービス不要 |
| Embedding生成 | Vertex AI **gemini-embedding-001**（出力768次元に設定） | GCPネイティブ・Firebaseと同一プロジェクト。**実装時に最新の推奨モデルを再確認すること** |
| コンテンツ取得 | Docusaurus: Markdownファイル直接読み込み | シンプル |
|  | WordPress: REST API（/wp-json/wp/v2/posts） | 標準搭載 |
| チャンク分割 | 段落単位・最大500トークン | バランス重視 |

### フロントエンド

| 項目 | 採用技術 |
|------|----------|
| フレームワーク | React (Vite) |
| スタイリング | Tailwind CSS |
| Firebase連携 | Firebase SDK（Firestoreリアルタイム購読） |

### AI

| 項目 | 内容 |
|------|------|
| モデル | claude-sonnet-4-6 |
| 用途 | 返信下書き生成・管理者チャット応答 |
| コンテキスト | RAGで取得した関連チャンクをsystemプロンプトに注入 |
| APIキー管理 | Cloud Functions の Secret Manager |

---

## 4. RAG構成詳細

### コンテンツ収集・ベクトル化フロー

```
1. Cloud Functions スケジュール（週1回 or 管理者の手動起動）で起動
2. Docusaurus: リポジトリまたは公開URLからMarkdownファイルを取得
   WordPress:  REST API（/wp-json/wp/v2/posts?per_page=100）で記事取得
3. テキストをチャンク分割（段落単位・最大500トークン・50トークンオーバーラップ）
4. Vertex AI gemini-embedding-001 でベクトル化
5. Firestore の knowledgeChunks コレクションに保存
   （既存チャンクはソースURLとハッシュで差分更新）
```

### 検索フロー（Claude API呼び出し前）

```
1. メール本文 or 管理者の質問をクエリとしてベクトル化
2. Firestore Vector Search で上位3〜5チャンクを取得
3. 取得チャンクをsystemプロンプトに注入してClaude APIを呼び出し
```

### systemプロンプト構造

```
あなたは「{アプリ名}」の管理者秘書です。
以下のマニュアル・ブログ情報を参考に回答してください。

--- 参考情報 ---
{RAGで取得したチャンク1}
{RAGで取得したチャンク2}
{RAGで取得したチャンク3}
---

情報が不足している場合はその旨を伝えてください。
```

### ベクトルインデックスの作成

ベクトルインデックスは `firestore.indexes.json`（`firebase deploy`）では定義できない。**gcloud CLI で作成**し、コマンドをREADMEに残す。

```bash
gcloud firestore indexes composite create \
  --collection-group=knowledgeChunks \
  --query-scope=COLLECTION \
  --field-config=field-path=embedding,vector-config='{"dimension":768,"flat":{}}'
```

---

## 5. Firestoreデータ構造

### コレクション：`emails`

**ドキュメントID = GmailのmessageId**（巡回が重複してもupsertで冪等）

```
emails/{gmailMessageId}
  ├── receivedAt: timestamp
  ├── category: "subscription" | "cancel" | "inquiry" | "bug" | "other"
  ├── subject: string
  ├── fromAddress: string
  ├── summary: string
  ├── draftStatus: "none" | "requested" | "generating" | "ready" | "drafted" | "error"
  │     none:       下書き不要（subscription / cancel / other）
  │     requested:  GASが下書き生成を依頼（inquiry / bug）
  │     generating: Functionsが処理中（排他フラグ）
  │     ready:      下書き本文が生成済み・Gmail未反映
  │     drafted:    GASがGmail下書きを作成済み
  │     error:      生成失敗（errorMessage参照）
  ├── draftText: string          // Functionsが生成した下書き本文
  ├── gmailDraftId: string       // GASが下書き作成後に書き込み
  ├── errorMessage: string
  └── processedAt: timestamp
```

### コレクション：`reports`

**ドキュメントID = `{period}_{YYYY-MM-DD}`**（例: `daily_2026-06-11`）。1日4回の巡回で同じIDにupsertするため重複しない。

```
reports/{period_date}
  ├── generatedAt: timestamp
  ├── period: "daily" | "weekly" | "monthly"
  ├── newSubscriptions: number
  ├── cancellations: number
  ├── inquiries: number
  ├── bugs: number
  └── summaryText: string
```

### コレクション：`chatQueue`

```
chatQueue/{requestId}
  ├── createdAt: timestamp
  ├── sessionId: string           // 会話セッション識別子（フロントが発行・保持）
  ├── question: string
  ├── answer: string
  ├── status: "pending" | "processing" | "done" | "error"
  ├── errorMessage: string
  └── updatedAt: timestamp
```

マルチターン会話: Functionsは同一 `sessionId` の `status == "done"` ドキュメントを `createdAt` 降順で最大10件取得し、messages配列（user/assistantの交互）として組み立ててClaudeに渡す。

### コレクション：`knowledgeChunks`（RAG用）

```
knowledgeChunks/{chunkId}
  ├── source: "docusaurus" | "wordpress"
  ├── sourceUrl: string
  ├── title: string
  ├── content: string          // チャンクテキスト
  ├── contentHash: string      // 差分更新用ハッシュ
  ├── embedding: vector(768)
  └── updatedAt: timestamp
```

---

## 6. 処理フロー詳細

### GAS 定時巡回フロー（1日4回）

```
1. GASトリガー起動（例：6時・12時・18時・22時）
2. GmailApp.search('in:inbox category:primary newer_than:3d') を、
   未処理スレッド（-label:secretary-processed）と処理済みスレッド
   （label:secretary-processed）の2系統で実行して対象取得
   ※ 未読フラグではなく Firestore の emails/{messageId} 存在確認で処理済み判定する
   ※ GmailAppのラベルはスレッド単位のため、処理済みラベル付きスレッドも再スキャンして新規返信を拾う
   ※ 1回の処理上限 50スレッド/クエリ。超過分は次回に持ち越し
3. スレッド内のInbox内メッセージだけを対象にし、送信済み返信を除外。
   既存docは documents:batchGet で一括確認して除外（メッセージごとのGETはしない）
4. 件名・本文からカテゴリを判定（キーワードマッチ）
5. Firestore REST API で emails コレクションに保存（docId = messageId で upsert）
   - inquiry / bug は draftStatus: "requested" をセット
   - それ以外は draftStatus: "none"
   - 検索期間（SEARCH_WINDOW）より古いメッセージは、再浮上した未処理スレッドの
     文脈保存として直近10件/スレッドまで保存するが draftStatus: "none"（下書き生成対象外）
   - SEARCH_WINDOW が解釈不能な場合は既定の3日をカットオフに使う（安全側）
   - 既存docは保存し直さず、draftStatus を requested / none に巻き戻さない
6. 処理済みスレッドに secretary-processed ラベルを一括付与（addToThreads・100スレッドずつ）
7. 集計（当日の新規・解約・問い合わせ数）を算出
8. Firestore REST API で reports/daily_{YYYY-MM-DD} に upsert
```

### GAS 下書き反映フロー（15分間隔の軽量トリガー）

```
1. Firestore REST API（runQuery）で draftStatus == "ready" のドキュメントを取得
2. 各ドキュメントについて:
   a. GmailApp.getMessageById(docId) で元メッセージを取得
   b. message.createDraftReply(draftText) で返信下書きを作成
   c. draftStatus: "drafted"・gmailDraftId を Firestore に書き戻し
3. 対象0件なら即終了（実行時間はほぼ消費しない）
```

### Cloud Functions：返信下書き生成フロー

```
トリガー：onDocumentCreated("emails/{emailId}")
※ トリガー自体にフィールド条件は指定できない。関数冒頭で
   draftStatus != "requested" なら即 return する。

1. 【冪等性ガード】トランザクションで draftStatus を
   "requested" → "generating" に遷移。既に generating / ready /
   drafted の場合は即 return（at-least-once配信による二重実行対策）
2. メール本文・件名を取得
3. メール内容をベクトル化 → Firestore Vector Search で関連チャンク取得（上位4件）
4. Claude API 呼び出し
   - system: RAGチャンクを注入したsystemプロンプト
   - user: メール内容 + 返信下書き生成の指示
5. 結果を Firestore に書き戻し
   - 成功: draftText: {生成本文}, draftStatus: "ready"
   - 失敗: draftStatus: "error", errorMessage: {内容}
※ Gmailへの下書き保存はGAS側（上記「下書き反映フロー」）が行う
```

### Cloud Functions：チャット応答フロー

```
トリガー：onDocumentCreated("chatQueue/{requestId}")

1. 【冪等性ガード】トランザクションで status を
   "pending" → "processing" に遷移。pending以外なら即 return
2. question を取得
3. 同一 sessionId の過去の done ドキュメントから直近10件の履歴を取得
4. 質問をベクトル化 → Firestore Vector Search で関連チャンク取得（上位4件）
5. 直近の reports・emails データもコンテキストとして付与
6. Claude API 呼び出し
   - system: RAGチャンクを注入したsystemプロンプト
   - messages: 履歴 + 管理者の質問
7. Firestore の該当ドキュメントを更新
   - 成功: answer: {回答テキスト}, status: "done"
   - 失敗: status: "error", errorMessage: {内容}
8. フロントがリアルタイム購読で回答を即時表示
```

### Cloud Functions：ナレッジ更新バッチフロー

```
トリガー：Cloud Schedulerで週1回 ＋ onCall（管理者の手動起動。
         呼び出し時に管理者判定を行う）

1. WordPress REST API で全記事取得
2. Docusaurus の公開URLからMarkdownを取得
3. チャンク分割・ハッシュ計算
4. 既存チャンクと差分比較
   - 新規・更新チャンク → Vertex AI でベクトル化 → Firestore に保存
   - 削除済みソース → Firestore から削除
```

---

## 7. リポジトリ構成（モノレポ）

GAS・Cloud Functions・フロントエンドを1つのリポジトリで管理する。デプロイ先はそれぞれ異なるが、コードは一元管理できる。

```
secretary-app/
  ├── gas/                          # GAS用（TypeScript + Vite + @gas-plugin/unplugin）
  │   ├── src/
  │   │   ├── main.ts               # エントリ（トリガー登録関数をexport）
  │   │   ├── gmail.ts              # Gmail巡回
  │   │   ├── classifier.ts         # メールカテゴリ判定
  │   │   ├── firestore.ts          # Firestore REST API読み書き
  │   │   ├── config.ts             # Script Properties読み出し
  │   │   └── draftWriter.ts        # 下書き反映（Phase 3で追加）
  │   ├── appsscript.json           # GASプロジェクト設定（oauthScopes必須・セクション9参照。
  │   │                             #   ビルド時にプラグインが dist/ へ自動コピー）
  │   ├── vite.config.ts            # @gas-plugin/unplugin/vite 設定
  │   ├── tsconfig.json
  │   ├── package.json
  │   ├── .clasp.json               # claspデプロイ設定（rootDir: "dist"。gitignore対象）
  │   └── .clasp.json.example       # scriptIdを伏せたテンプレート
  │
  ├── functions/                    # Cloud Functions用
  │   ├── src/
  │   │   ├── index.js              # Functionsエントリーポイント
  │   │   ├── draftGenerator.js     # 返信下書き本文生成
  │   │   ├── chatResponder.js      # チャット応答
  │   │   ├── knowledgeUpdater.js   # ナレッジ更新バッチ（schedule + onCall）
  │   │   ├── ragSearch.js          # RAG検索共通モジュール
  │   │   └── claudeClient.js       # Claude API共通クライアント
  │   └── package.json
  │
  ├── frontend/                     # Reactフロント用
  │   ├── src/
  │   │   ├── App.jsx
  │   │   ├── components/
  │   │   │   ├── Secretary.jsx     # 秘書キャラクター
  │   │   │   ├── Dashboard.jsx     # レポートダッシュボード
  │   │   │   ├── ChatPanel.jsx     # チャットUI
  │   │   │   └── EmailList.jsx     # メール一覧
  │   │   └── pages/
  │   ├── index.html
  │   └── package.json
  │
  ├── firebase.json                 # Firebase設定（functions/frontendを参照）
  ├── firestore.rules               # Firestoreセキュリティルール
  ├── firestore.indexes.json        # 通常の複合インデックス
  │                                 # ※ ベクトルインデックスは gcloud CLI（README参照）
  ├── .firebaserc                   # Firebaseプロジェクト設定
  └── README.md                     # ベクトルインデックス作成コマンド等を記載
```

### デプロイコマンド

| 対象 | コマンド | ツール |
|------|----------|--------|
| GAS | `cd gas && npm run push`（typecheck → vite build → clasp push） | Vite + clasp |
| Cloud Functions | `firebase deploy --only functions` | Firebase CLI |
| フロントエンド | `firebase deploy --only hosting` | Firebase CLI |
| 全Firebase | `firebase deploy` | Firebase CLI |

### claspセットアップ（GAS）

```bash
npm install -g @google/clasp
clasp login
cd gas
clasp clone <GAS_SCRIPT_ID>   # 既存プロジェクトと紐付け
# または
clasp create --type standalone # 新規作成
```

`.clasp.json` の `rootDir` には Vite のビルド出力 `"dist"` を指定する（claspはdist/のCode.jsとappsscript.jsonだけをpushする）。`scriptId` を含むため `.clasp.json` はgitignoreし、`.clasp.json.example` をテンプレートとして置く。

---

## 8. Cloud Functions 構成（Node.js / 第2世代）

| 関数名 | 種別 | トリガー | 役割 |
|--------|------|----------|------|
| `generateDraft` | Firestoreトリガー | `onDocumentCreated("emails/{emailId}")` | 返信下書き本文の生成（draftStatus == "requested" のみ処理） |
| `respondChat` | Firestoreトリガー | `onDocumentCreated("chatQueue/{requestId}")` | チャット応答生成 |
| `updateKnowledgeScheduled` | スケジュール | `onSchedule("every monday 03:00")` | ナレッジ週次更新 |
| `updateKnowledgeManual` | HTTPS Callable | `onCall`（管理者判定あり） | ナレッジ手動更新（フロントの更新ボタンから） |

| 項目 | 内容 |
|------|------|
| ランタイム | Node.js 20以上 |
| リージョン | asia-northeast1（Firestoreと同一リージョンに揃える） |
| シークレット | `CLAUDE_API_KEY` を Secret Manager から注入（`defineSecret`） |
| Vertex AI認証 | Functionsのサービスアカウント（ADC）。`roles/aiplatform.user` を付与 |
| タイムアウト | generateDraft / respondChat: 120秒、knowledgeUpdater: 540秒 |
| 冪等性 | Firestoreトリガーは at-least-once 配信。各関数冒頭でトランザクションによる status 排他遷移を行う（セクション6参照） |

---

## 9. GAS → Firestore REST API 書き込みサンプル

実装はTypeScript（`gas/src/firestore.ts`）。以下は仕組みを説明するためのサンプル。プロジェクトIDなどの設定値はコードにハードコードせず、**Script Properties**（`FIREBASE_PROJECT_ID` ほか。`gas/src/config.ts` 参照）から読む。

```javascript
function writeToFirestore(collection, docId, data) {
  const projectId = 'your-project-id';
  const token = ScriptApp.getOAuthToken();

  const fields = {};
  const fieldPaths = [];
  Object.keys(data).forEach(key => {
    const val = data[key];
    fieldPaths.push(key);
    if (val instanceof Date) {
      fields[key] = { timestampValue: val.toISOString() };
    } else if (typeof val === 'string') {
      fields[key] = { stringValue: val };
    } else if (typeof val === 'number') {
      fields[key] = Number.isInteger(val)
        ? { integerValue: String(val) }   // REST APIでは整数は文字列で渡す
        : { doubleValue: val };
    } else if (typeof val === 'boolean') {
      fields[key] = { booleanValue: val };
    }
  });

  // updateMaskを付けないとドキュメント全体が置き換わる（partial updateにする）
  const mask = fieldPaths.map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}` +
              `/databases/(default)/documents/${collection}/${docId}?${mask}`;

  const res = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    contentType: 'application/json',
    payload: JSON.stringify({ fields }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(`Firestore write failed: ${res.getResponseCode()} ${res.getContentText()}`);
  }
}
```

### 前提条件（最初のハマりどころ）

1. **`appsscript.json` に oauthScopes を明示する**（`getOAuthToken()` にdatastoreスコープを含めるため）:

```json
{
  "timeZone": "Asia/Tokyo",
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/datastore",
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

2. **GAS実行アカウント（=管理者のGoogleアカウント）に、FirebaseプロジェクトのIAMロール `roles/datastore.user` を付与する**。これがないとREST APIが403を返す。

3. ユーザーOAuthトークン＋IAM権限によるREST APIアクセスは**セキュリティルールを経由しない**（特権アクセス扱い）。そのためルールを管理者限定に絞ってもGASの読み書きは影響を受けない。

---

## 10. フロントエンド画面構成

### ダッシュボード（メイン画面）
- 秘書キャラクター画像 + 最新レポートの読み上げ表示
- 本日の新規登録数 / 解約数 / 問い合わせ数
- 未対応メール一覧（draftStatus が requested / generating / ready / error のもの）

### チャットパネル
- 管理者が質問を入力（フロントが sessionId を発行・セッション中保持）
- chatQueue にドキュメント追加 → Firestoreリアルタイム購読で回答を表示
- status == "error" の場合はエラーメッセージと再試行ボタンを表示

### メール詳細
- 各メールのカテゴリ・要約・生成された下書きへのリンク（Gmail下書きURL）

### ナレッジ管理（管理者のみ）
- ナレッジ最終更新日時の表示
- 手動更新ボタン（`updateKnowledgeManual` を onCall で起動）

---

## 11. セキュリティ

| 項目 | 対策 |
|------|------|
| ダッシュボードアクセス | Firebase Auth（Googleログイン）＋**管理者判定**。認証済みであることと管理者であることは別（Googleログインは誰でも可能） |
| 管理者判定 | 初期: 管理者メールアドレスのホワイトリスト。複数人運用になったらカスタムクレーム（`role: "admin"`）に移行 |
| Firestoreルール | 管理者限定＋フィールドレベル制御（下記） |
| Claude APIキー | Cloud Functions の Secret Manager で管理 |
| Vertex AI | Cloud Functions のサービスアカウントで認証 |
| GAS OAuth | GASのOAuthトークン＋IAM（datastore.user）でFirestore REST APIアクセス |
| 設定値の管理 | GAS: **Script Properties**（.envは使わない・GAS実行環境に存在しない）／フロント: Viteの`.env`（バンドルに埋め込まれるため公開可能な値のみ）／秘匿情報（Claude APIキー）: Secret Manager |
| Gmailスコープ | 自動送信は行わない方針。ただし下書き作成に必要な compose / modify スコープは技術的には送信も可能なため、**「送信APIを呼ぶコードを書かない」ことをコード規約として担保**する（スコープだけでは送信を防げない点に注意） |
| プライバシー | 顧客メール本文を外部API（Claude）へ送信する構成のため、自社プライバシーポリシーとAnthropicのデータ取り扱い規約を実装前に確認する |

### Firestoreセキュリティルール（方針）

クライアント（フロント）からのアクセスのみがルールの対象。FunctionsはAdmin SDK、GASはIAM特権アクセスのためルールを経由しない。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      return request.auth != null
        && request.auth.token.email in ['admin@example.com'];
      // 複数人運用時は request.auth.token.role == 'admin' に移行
    }

    match /emails/{id}          { allow read: if isAdmin(); allow write: if false; }
    match /reports/{id}         { allow read: if isAdmin(); allow write: if false; }
    match /knowledgeChunks/{id} { allow read: if isAdmin(); allow write: if false; }

    match /chatQueue/{id} {
      allow read: if isAdmin();
      // クライアントは質問の新規作成のみ。answer/statusの書き換えはFunctionsだけ
      allow create: if isAdmin()
        && request.resource.data.keys().hasOnly(
             ['createdAt', 'sessionId', 'question', 'status'])
        && request.resource.data.status == 'pending';
      allow update, delete: if false;
    }
  }
}
```

---

## 12. 開発フェーズ

| フェーズ | 内容 | 目安 |
|----------|------|------|
| Phase 1 | GAS：Gmail巡回・分類・Firestore書き込み（ラベル管理・upsert含む） | 1週間 |
| Phase 2 | RAG：ナレッジ収集・ベクトル化バッチ構築 | 1週間 |
| Phase 3 | Cloud Functions：返信下書き生成（RAG統合）＋ GAS：下書き反映フロー | 1週間 |
| Phase 4 | Reactダッシュボード・秘書キャラクターUI | 1〜2週間 |
| Phase 5 | チャット機能・Cloud Functions：チャット応答（セッション履歴対応） | 1週間 |

---

## 13. コスト概算（月額）

| サービス | 費用 |
|----------|------|
| GAS | 無料 |
| Firebase（Firestore・Functions・Hosting） | 無料枠内に収まる見込み。**ただしBlazeプラン登録（クレジットカード）必須** |
| Vertex AI Embedding（週1回バッチ） | 数十円程度 |
| Claude API | 月$5〜$15程度を想定 |
| **合計** | **ほぼClaude API + Vertex AIのみ** |

---

## 14. 開発時の注意点

### GASの実行時間・クォータ
Gmail取得件数が増えると6分制限に近づく。1回の巡回で取得するメール数に上限を設けておき（例：最大50件）、超えた場合は次回に持ち越す設計にしておくと安全。下書き反映トリガーは対象0件なら即終了するため15分間隔でも実行時間をほぼ消費しない。

### Firestoreのコスト設計
無料枠はread 50,000回/日・write 20,000回/日。フロントのリアルタイム購読を多用するとreadがかさみやすいため、必要なコレクションだけ購読する設計にする。

### Claude APIのコンテキスト管理
チャット履歴はsessionId単位で直近10件に絞って渡す（スキーマとフローに織り込み済み）。1セッションが長期化する場合は要約への切り替えを検討する。

### RAGのチャンク品質
Docusaurusのページ構造やWordPressの記事によってはチャンク分割がうまくいかないケースがある。実際のコンテンツで精度検証してからチャンクサイズを調整する余裕を開発スケジュールに入れておく。

### Gmail下書きの誤生成対策
問い合わせでないメール（例：プロモーションタブのメール）が誤分類されて下書きが大量生成されるリスクがある。GmailApp.searchの検索条件（`category:primary` 等）で入口を絞った上で、対象メールのラベルやFromアドレスによる事前フィルタリング条件を厳しめに設定しておく。

### 下書き反映の遅延
Functionsが本文を生成してからGASがGmail下書き化するまで最大15分の遅延がある。下書きは人間が確認してから送る運用のため許容範囲とするが、即時性が必要になった場合はGAS側トリガーの間隔短縮（最短1分）で対応する。

---

## 15. 将来の拡張候補

### メール分類をClaude APIに昇格
現状はキーワードマッチだが、分類精度を上げたい段階でCloud FunctionsからClaude APIで分類する構成に切り替えられるよう、分類ロジックをGAS内で関数として独立させておくと移行しやすい。

### 多言語対応
ユーザーが増えると英語など他言語の問い合わせが来る可能性がある。Claude APIは多言語対応しているが、キーワード分類がある限り日本語前提になる。早めにClaude分類に切り替えるか、言語検出を挟む設計を意識しておく。

### 管理者の複数アカウント対応
Firebase Authで複数アカウントを許可する設計は最初から入れておく。Firestoreのセキュリティルールもメールアドレスのホワイトリストからカスタムクレーム（ロール単位）に移行する。

### ナレッジの鮮度管理（Webhook化）
WordPressは記事更新時にWebhookで即時トリガーをかける仕組みが比較的簡単に作れる。週次バッチと併用することでRAGの情報鮮度を高めることができる。

### 将来のMCP対応
現状はRAGで代替しているが、MCPのサーバーレス対応が成熟した段階でDocusaurus・WordPressをMCPサーバーとして接続する構成に移行すると、RAGのメンテナンスコストを削減できる。

### その他
- Slack通知連携（重要メール即時通知）
- Google Sheets への売上データ自動エクスポート
- 秘書キャラクターの音声読み上げ（Web Speech API）
