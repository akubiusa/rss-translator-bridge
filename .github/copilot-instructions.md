# GitHub Copilot Code Review Instructions

RSS Translator Bridge（Fastify + TypeScript ESM、GAS 翻訳 API を使う RSS 翻訳サーバー、Vercel デプロイ）のコードレビュー用指示。

## レビューの重点

- **翻訳失敗時のフォールバック**: GAS API 呼び出しや RSS 解析が失敗したとき、例外を握りつぶさず、元テキストへフォールバックしていること。フォールバックを飛ばして空文字や `undefined` を返す変更は指摘する。
- **タイムアウト整合性**: GAS 呼び出しのタイムアウト（バッチ 25 秒 / 個別 5 秒）は Vercel の 30 秒上限（`vercel.json` の `maxDuration`）内に収まる必要がある。この境界を超える変更や `AbortController` を外す変更は指摘する。
- **型安全性**: `any` の新規追加、不要な型アサーション (`as`)、`@ts-ignore` は指摘する。TypeScript strict 前提。
- **環境変数**: 新しい環境変数は `src/config.ts` で一元的に読み取り、`.env.example` と `README.md`・`CLAUDE.md` に追記されていること。`process.env` を config 以外で直接参照する変更は指摘する。
- **キャッシュ**: 翻訳キャッシュ（`src/translation-cache.ts`）のキー生成や TTL/最大件数の扱いに副作用や境界バグがないか確認する。
- **秘匿情報**: `GAS_URL` などの認証情報・URL や個人情報がコード・ログ・テストにハードコードされていないこと。

## コーディング規約

- コメント・JSDoc は日本語、エラーメッセージは英語。日本語と英数字の間は半角スペース。
- 公開関数・インターフェースには日本語 JSDoc を付ける。
- ES modules。相対 import の拡張子は `.js`（例: `./types.js`）で書く点に注意。

## テスト

- Jest + ts-jest、テストは `src/__tests__/`。新機能・バグ修正にはテスト追加を期待する。
- HTTP クライアントは `fetch`（axios ではない）。テストは `fetch` や `rss-parser`、内部モジュールを `jest.mock` でモックする。

## フラグ不要な既知パターン（誤検知しないこと）

- 相対 import に付く `.js` 拡張子は ESM 仕様どおりで正しい。TypeScript ソースなのに `.ts` にすべき、という指摘は不要。
- `preinstall` の `npx only-allow pnpm` は意図的な pnpm 強制。
- エラーメッセージ先頭の絵文字は既存の意図的なスタイル。
- 翻訳失敗時に元テキストを返すのは仕様どおりのフォールバックであり、バグではない。

## 対象外

- lint / format（Prettier + ESLint `@book000/eslint-config`）が機械的に強制する整形の指摘は不要。CI で担保される。
