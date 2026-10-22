# CLAUDE.md

Claude Code (claude.ai/code) がこのリポジトリで作業する際の方針とプロジェクト固有ルール。

## プロジェクト概要

RSS Translator Bridge は、RSS フィードを翻訳する Fastify ベースの Web サーバー。Google Apps Script (GAS) 翻訳 API を使って RSS のタイトル・本文をバッチ翻訳し、翻訳済み RSS XML を返す。翻訳結果はインメモリキャッシュされ、レスポンスには CDN 向けの `Cache-Control` を付与する。Vercel のサーバーレス関数としてデプロイされる。

## 開発コマンド

パッケージマネージャーは **pnpm**（`preinstall` で `only-allow pnpm` を強制）。

```bash
pnpm install        # 依存関係インストール
pnpm dev            # 開発サーバー起動（tsx watch でホットリロード）
pnpm start          # サーバー起動（tsx）
pnpm build          # tsc でビルド
pnpm test           # Jest でテスト実行
pnpm typecheck      # tsc --noEmit（= lint:tsc）
pnpm lint           # prettier + eslint + tsc をまとめて実行（コミット前に必須）
pnpm fix            # prettier --write と eslint --fix をまとめて実行
```

個別実行: `pnpm lint:prettier` / `pnpm lint:eslint` / `pnpm lint:tsc` / `pnpm fix:prettier` / `pnpm fix:eslint`。

単一テスト: `pnpm test translator.test.ts` のようにファイル名を指定。

## アーキテクチャと主要ファイル

- `src/index.ts`: サーバーの起動（`getApp()` は `buildApp()` に `public/` の配信元を渡す）。`import.meta` を使うため Jest からは読み込めない。
- `src/app.ts`: Fastify アプリの組み立て（`buildApp()`）。`@fastify/static` で `public/`（Web UI）を `/` に配信し、`GET /health` / `GET /api`（翻訳） / `GET /api/proxy`（元 RSS 取得プロキシ）を定義。取得処理のエラーを HTTP ステータスへ対応付ける。
- `src/safe-fetch.ts`: 利用者が指定した URL を安全に取得する（SSRF 対策）。スキーム・宛先 IP・リダイレクト・タイムアウト・応答サイズを制限する。
- `src/config.ts`: 環境変数から `Config` を構築（`loadConfig()`）。`GAS_URL` 未設定時は起動時に例外。
- `src/rss-processor.ts`: `safe-fetch.ts` で取得したフィードを `rss-parser` で解析し、翻訳後に `xml2js` で XML を再構築。
- `src/translator.ts`: GAS API へ `fetch` で JSON を POST してバッチ翻訳。`AbortController` によるタイムアウト付き（バッチ 25 秒 / 個別 5 秒）。翻訳失敗時は元テキストにフォールバック。
- `src/translation-cache.ts`: 翻訳結果のインメモリ TTL キャッシュ（`Map` ベース、上限超過分を削除）。キー（`sha256` ハッシュ）は `translator.ts` 側で生成する。
- `src/cache-control.ts`: CDN 向け `Cache-Control` ヘッダー（`s-maxage` / `stale-while-revalidate`）を生成。
- `src/types.ts`: 型定義（`Config`、RSS、翻訳リクエスト/レスポンス等）。
- `api/serverless.ts`: Vercel サーバーレス関数のエントリーポイント。

データフロー: クライアント → `GET /?url=…` → `RSSProcessor` が `safeFetchText` で取得・解析 → `Translator` が GAS へバッチ翻訳（キャッシュ経由）→ 翻訳結果を RSS に反映して XML で返却。

## コーディング規約

- 会話・コード内コメント・JSDoc は日本語。エラーメッセージは英語。
- 日本語と英数字の間には半角スペースを入れる。
- TypeScript strict モード準拠。型安全性を重視し `any` 型の多用を避ける。
- 関数・インターフェースには JSDoc を日本語で記載・更新する。
- エラーメッセージの先頭に絵文字がある既存パターンに合わせる場合、メッセージ内容に即した一文字の絵文字を付ける。
- フォーマット/lint は Prettier + ESLint (`@book000/eslint-config`) が強制する。ローカルで `pnpm lint` を通してからコミットする。

## テスト

- Jest + ts-jest。テストは `src/__tests__/` に配置。
- 外部依存はモックする: `fetch`（GAS 呼び出し）、`rss-parser`、`../safe-fetch` の `safeFetchText`、および `../translator` / `../config` 等の内部モジュールを `jest.mock` でモックする（HTTP クライアントは `fetch` であり axios は使っていない）。
- 新機能追加時はテストを追加し、エラーハンドリングと翻訳失敗時のフォールバック動作も検証する。

## 環境変数

必須:

- `GAS_URL`: GAS 翻訳 API の URL。

オプション（デフォルト値）:

- `PORT` (3000) / `HOST` (0.0.0.0)
- `DEFAULT_SOURCE_LANG` (auto) / `DEFAULT_TARGET_LANG` (ja)
- `DEFAULT_EXCLUDE_FEED_TITLE` (true) / `DEFAULT_EXCLUDE_ITEM_TITLE` (false)
- `TRANSLATION_CACHE_ENABLED` (true) / `TRANSLATION_CACHE_TTL_MS` (21600000) / `TRANSLATION_CACHE_MAX_ITEMS` (1000)
- `CDN_CACHE_ENABLED` (true) / `CDN_CACHE_S_MAXAGE` (300) / `CDN_CACHE_STALE_WHILE_REVALIDATE` (60)

`.env.example` を追随させること。本番の環境変数は Vercel 側で管理する。

## API 仕様

- `GET /api`: RSS を翻訳して返すメインエンドポイント。クエリ `url`（必須）、`sourceLang` / `targetLang` / `excludeFeedTitle` / `excludeItemTitle`（任意）。成功時は翻訳済み RSS XML、失敗時はエラー JSON。
- `GET /api/proxy`: 元 RSS を取得して返すプロキシ（Web UI の CORS 回避用）。クエリ `url`（必須）。上流が 2xx 以外を返した場合はそのステータスを返す。
- 取得エラーのステータス（`/api` と `/api/proxy` 共通）: 400（`url` が未指定・複数指定、または不正なスキーム・内部アドレスなどの取得先）、502（応答サイズの上限超過、リダイレクトの回数超過・`Location` なし）、504（取得の総タイムアウト超過）、500（上記以外の取得・解析・翻訳の失敗）。
- `GET /health`: ヘルスチェック。
- `GET /`: `public/` の静的な Web UI（`@fastify/static` が配信）。

## リポジトリ固有の注意

- Vercel のサーバーレス関数は最大 30 秒（`vercel.json` の `maxDuration: 30`）。GAS 呼び出しは 25 秒でタイムアウトさせ 30 秒制限内に収める。
- 利用者が指定する URL の取得は必ず `safeFetchText` 経由にする（`fetch` や `RSSParser.parseURL` を直接使わない）。http/https 以外のスキームと内部アドレスは拒否し、総期限 5 秒（DNS 解決・リダイレクト・本文受信）・展開後 5 MiB・リダイレクト 5 回までに制限する。
- RSS のアイテム数制限なし（全件翻訳）。
- HTML コンテンツ（`content:encoded` / `description` / `summary`）の翻訳に対応。
- Renovate が作成した PR には追加コミットしない。

## ドキュメント更新ルール

- API・環境変数・使い方の変更 → `README.md`。
- 環境変数の追加・変更 → `.env.example` と本ファイルの「環境変数」。
- アーキテクチャ・コマンド・実装パターンの変更 → 本ファイル。
- レビュー観点に関わる規約の変更 → `.github/copilot-instructions.md`。

## セキュリティ

- API キー・認証情報は `.env` で管理し、コミットしない（`.env.example` はサンプル値のみ）。
- ログに認証情報や個人情報を出力しない。

## Git

- コミットメッセージは [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)。`<description>` は日本語。
- ブランチは [Conventional Branch](https://conventional-branch.github.io) の短縮形（`feat`, `fix` 等）。
- CI (`.github/workflows/ci.yml`) は `book000/templates` の再利用ワークフローで lint とテストを実行する。
