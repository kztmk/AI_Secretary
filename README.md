# 秘書アプリ（AI Secretary）

管理者向けAI秘書アプリ。GAS + Firebase + RAG + Claude API 構成。

仕様書: `secretary_app_spec_v4.md`（GAS=Gmail係 / Cloud Functions=AI係 / Firestore=共有ストア兼キュー）

## ワークスペース

| ディレクトリ | 内容 | 状態 |
|--------------|------|------|
| `gas/` | Gmail定時巡回・分類・集計・Firestore書き込み（TypeScript + Vite + @gas-plugin/unplugin） | Phase 1 実装済み |
| `functions/` | RAG検索・Claude API呼び出し（Cloud Functions） | Phase 2〜 |
| `frontend/` | ダッシュボード・チャットUI（React + Vite + Tailwind） | Phase 4〜 |

セットアップ手順は各ワークスペースのREADMEを参照。
