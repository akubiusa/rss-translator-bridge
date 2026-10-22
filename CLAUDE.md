# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

RSS Translator Bridgeは、RSSフィードを翻訳するFastifyベースのWebサーバーです。Google Apps Script（GAS）翻訳APIを使用してRSSフィードのタイトルと本文をバッチ翻訳し、翻訳済みのRSS XMLを返します。

## アーキテクチャ

### 主要コンポーネント

- **index.ts**: サーバーの起動（`import.meta` を使うため、Jest からは読み込めない）
- **app.ts**: Fastifyアプリケーションの設定とルーティング（`buildApp`）
- **safe-fetch.ts**: 取得先を検証するRSS取得処理（SSRF対策。スキーム・宛先IP・リダイレクト・タイムアウト・サイズ上限）
- **rss-processor.ts**: safe-fetch で取得した本文を RSSParser で解析・XML再構築
- **translator.ts**: GAS API を使用したバッチ翻訳処理
- **types.ts**: TypeScript型定義（RSS、翻訳リクエスト/レスポンス）
- **config.ts**: 環境変数ベースの設定管理

### データフロー

1. クライアント → GET /?url=&sourceLang=&targetLang=
2. RSSProcessor → safeFetchText で RSS取得 → 解析 → バッチ翻訳項目の準備
3. Translator → GAS API への バッチ翻訳リクエスト
4. レスポンス → 翻訳結果をRSSに適用 → XML形式で返却

## 開発コマンド

### パッケージマネージャー

このプロジェクトは **pnpm** を使用します（package.jsonにpackageManagerが指定済み）。

### 基本コマンド

```bash
# 開発サーバー起動（ホットリロード）
pnpm dev

# プロダクションサーバー起動
pnpm start

# ビルド
pnpm build

# 品質チェック（コミット前に必須実行）
pnpm lint

# テスト実行
pnpm test

# 型チェック
pnpm typecheck
```

### 詳細コマンド

```bash
# Prettier チェック
pnpm lint:prettier

# ESLint チェック
pnpm lint:eslint

# TypeScript型チェック
pnpm lint:tsc

# Prettier 自動修正
pnpm fix:prettier

# ESLint 自動修正
pnpm fix:eslint
```

## 環境変数

### 必須

- `GAS_URL`: Google Apps Script翻訳APIのURL

### オプション

- `PORT`: サーバーポート（デフォルト: 3000）
- `HOST`: サーバーホスト（デフォルト: 0.0.0.0）
- `DEFAULT_SOURCE_LANG`: デフォルトソース言語（デフォルト: auto）
- `DEFAULT_TARGET_LANG`: デフォルトターゲット言語（デフォルト: ja）
- `DEFAULT_EXCLUDE_FEED_TITLE`: RSS フィードタイトルを翻訳しないかどうか（デフォルト: true）
- `DEFAULT_EXCLUDE_ITEM_TITLE`: RSS 記事タイトルを翻訳しないかどうか（デフォルト: false）

## API仕様

### GET /

RSSフィードを翻訳して返すメインエンドポイント

**クエリパラメータ:**

- `url` (必須): 翻訳対象のRSSフィードURL
- `sourceLang` (オプション): ソース言語コード
- `targetLang` (オプション): ターゲット言語コード
- `excludeFeedTitle` (オプション): RSS フィードタイトルを翻訳しないかどうか（true/false）
- `excludeItemTitle` (オプション): RSS 記事タイトルを翻訳しないかどうか（true/false）

**レスポンス:** 翻訳済みRSS XML または エラーJSON

**エラーステータス（`/api` と `/api/proxy` 共通）:**

- 400: `url` が未指定・複数指定、または不正なスキーム・内部アドレスなどの取得先
- 502: 応答サイズの上限超過、リダイレクトの回数超過・`Location` なし
- 504: 取得の総タイムアウト超過
- 500: 上記以外の取得・解析・翻訳の失敗

### GET /api/proxy

翻訳前の元のRSSを取得して返す。`/api` と同じ取得先の制限（`safe-fetch.ts`）を受ける。上流が2xx以外を返した場合はそのステータスを返す。

### GET /health

ヘルスチェックエンドポイント

## テスト

Jest + ts-jest を使用。`src/__tests__/` ディレクトリにテストファイルを配置。

### テスト実行

```bash
# 全テスト実行
pnpm test

# 単一ファイルテスト
pnpm test rss-processor.test.ts
```

## コーディング規約

- ESLint設定: `@book000/eslint-config` ベース
- TypeScript strict モード有効
- Prettier による自動フォーマット
- ES modules 使用（package.json で type: "module"）
- Node.js 18.x 以上が必要

## Vercel デプロイ

`vercel.json` で設定済み。`/api/serverless.ts` でサーバーレス関数として動作。

## ワークフロー自動化

### Issue対応フロー

`"issue #nn を対応してください"` コマンドで以下を自動実行:

```bash
1. gh issue view {nn}                    # Issue情報取得
2. git checkout -b issue-{nn}-{description} --no-track origin/main  # ブランチ作成
3. # 実装作業
4. pnpm lint && pnpm test                # 品質検証
5. git commit -m "feat: {title}\n\nCloses #{nn}"  # コミット
6. git push -u origin {branch}           # プッシュ
7. gh pr create --title "feat: {title}" --body "Closes #{nn}"  # PR作成
```

### レビュー対応フロー

`"レビューに対応してください"` コマンドで以下を自動実行:

```bash
1. gh api repos/{owner}/{repo}/pulls/{pr}/comments  # コメント取得
2. Copilot/Human コメントの分類・対応
3. 修正実装
4. pnpm lint && pnpm test               # 品質検証
5. git commit && git push               # コミット・プッシュ
6. GraphQL APIでreview thread解決
```

### Git操作の自動化

- リモート判定: upstream 優先、非存在時は origin 使用
- ブランチ作成: `--no-track` で独立ブランチ作成
- Conventional Commits 形式でのコミット

## 注意事項

- バッチ翻訳でVercelの30秒制限を回避（GAS側のタイムアウト: 25秒）
- 利用者が指定するURLの取得は必ず `safeFetchText` 経由にする（`fetch` や `RSSParser.parseURL` を直接使わない）。取得は5秒（DNS解決・リダイレクト・本文受信の総期限）・展開後5MiB・リダイレクト5回までで、http/https以外と内部アドレスは拒否する
- 翻訳失敗時は元のテキストをフォールバックとして使用
- RSSフィードのアイテム数制限なし（全件翻訳）
- HTMLコンテンツの翻訳に対応（content:encoded, description, summary）
