# gas/ — Gmail定時巡回（Phase 1）

TypeScript + Vite + [@gas-plugin/unplugin](https://www.npmjs.com/package/@gas-plugin/unplugin) で書いたGASプロジェクト。
`vite build` で `dist/Code.js` にバンドルし、clasp で push する。

## 役割（仕様書v4 セクション6）

- `pollGmail()` — 1日4回の時間ベーストリガーで実行
  1. `in:inbox category:primary -label:secretary-processed newer_than:3d` を検索（上限50スレッド）
  2. キーワードマッチでカテゴリ判定（subscription / cancel / inquiry / bug / other）
  3. Firestore `emails/{messageId}` にupsert（inquiry / bugは `draftStatus: "requested"`）
  4. 処理済みスレッドに `secretary-processed` ラベルを付与
  5. 当日分をFirestoreから集計し `reports/daily_{yyyy-MM-dd}` にupsert

## セットアップ

### 1. 依存インストールとGAS紐付け

```bash
npm install
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "secretary-gas"  # または clasp clone <SCRIPT_ID>
cp .clasp.json.example .clasp.json   # scriptIdを記入し、rootDirが"dist"であることを確認
```

`.clasp.json` は scriptId を含むため **gitignore対象**（コミットしない）。

### 2. GCP側の準備

1. GASプロジェクトのGCPプロジェクトをFirebaseプロジェクトに切り替える
   （GASエディタ > プロジェクトの設定 > Google Cloud Platform（GCP）プロジェクト）
2. **GAS実行アカウント（管理者のGoogleアカウント）に、Firebaseプロジェクトの
   IAMロール `roles/datastore.user` を付与**（ないとFirestore REST APIが403）

### 3. Script Properties（GASエディタ > プロジェクトの設定 > スクリプト プロパティ）

| キー | 必須 | 既定値 | 説明 |
|------|------|--------|------|
| `FIREBASE_PROJECT_ID` | ✅ | — | FirebaseプロジェクトID |
| `PROCESSED_LABEL` | — | `secretary-processed` | 処理済みラベル名 |
| `MAX_THREADS_PER_RUN` | — | `50` | 1回の巡回で処理するスレッド上限（6分制限対策） |
| `SEARCH_WINDOW` | — | `3d` | Gmail検索の対象期間（`newer_than:` の値） |

設定値を `.env` でなくScript Propertiesに置くのは、GAS実行環境に `.env` が存在しないため。
コードへのハードコードも `clasp push` でソースごとGASプロジェクトに公開されるため避ける。

### 4. デプロイとトリガー登録

```bash
npm run push   # typecheck → vite build → clasp push
```

GASエディタの「トリガー」から `pollGmail` を時間主導型で登録（6時間おき ≒ 1日4回）。
初回は手動で `pollGmail` を1度実行して、OAuthスコープの承認とラベル作成を済ませる。

## 開発コマンド

| コマンド | 内容 |
|----------|------|
| `npm run typecheck` | tscの型チェックのみ（emitなし） |
| `npm run build` | `dist/Code.js` + `dist/appsscript.json` を生成 |
| `npm run push` | typecheck → build → clasp push |

## 構成

```
src/
  main.ts        # エントリ。トリガー登録関数はここからexportする
  gmail.ts       # 巡回フロー本体
  classifier.ts  # キーワードマッチ分類（将来Claude分類に差し替え予定）
  firestore.ts   # Firestore REST API（upsert / runQuery集計）
  config.ts      # Script Properties読み出し
```

**トリガーに登録する関数は必ず `main.ts` からexportすること。**
exportしない関数はバンドルに畳み込まれ、GASのトリガー設定画面に現れない。

## 既知の制限

- GmailAppのラベルは**スレッド単位**のため、処理済みラベルが付いたスレッドへの
  新規返信は次回検索にかからない（`-label:` で除外されるため）。
  実害が出たら「`label:secretary-processed is:unread` を対象にした追加スキャン」か
  「最終巡回時刻を`after:`で使う方式」への変更を検討する。
- `reports` の集計は `receivedAt >=` スクリプトタイムゾーンの当日0時。Firestoreの
  単一フィールドインデックス（自動）で動くため追加のインデックス作成は不要。
