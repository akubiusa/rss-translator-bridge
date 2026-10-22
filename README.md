# RSS Translator Bridge

RSS フィードを多言語翻訳するための高速ブリッジサーバーです。Google Apps Script（GAS）翻訳 API を使用してバッチ翻訳を行い、翻訳済みの RSS フィードを XML 形式で配信します。

## ✨ 特徴

- 🚀 **高速バッチ翻訳**: 複数項目を一括処理して高いパフォーマンスを実現
- 🌐 **多言語対応**: Google Translate を通じて 100+ 言語をサポート
- 📦 **完全な RSS 互換性**: 元の RSS 構造とメタデータを完全に保持
- ⚡ **サーバーレス対応**: Vercel での高可用性デプロイに最適化
- 🛡️ **エラー耐性**: 翻訳失敗時は元テキストをフォールバックとして使用
- 📝 **HTML コンテンツ対応**: `content:encoded`、`description`、`summary` を適切に処理

## 🚀 クイックスタート

### 使用方法

```
GET https://your-domain.com/?url=RSS_FEED_URL&sourceLang=SOURCE&targetLang=TARGET
```

**例**: 英語の RSS フィードを日本語に翻訳

```
https://your-domain.com/?url=https://example.com/feed.xml&sourceLang=en&targetLang=ja
```

### パラメータ

| パラメータ   | 必須 | 説明                                                                                  | デフォルト |
| ------------ | ---- | ------------------------------------------------------------------------------------- | ---------- |
| `url`        | ✅   | 翻訳対象の RSS フィード URL                                                           | -          |
| `sourceLang` | ❌   | ソース言語コード ([ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes)) | `auto`     |
| `targetLang` | ❌   | ターゲット言語コード                                                                  | `ja`       |

### サポート言語

Google Translate API がサポートする全ての言語に対応：

| 言語コード | 言語名     | 言語コード | 言語名     |
| ---------- | ---------- | ---------- | ---------- |
| `auto`     | 自動検出   | `ja`       | 日本語     |
| `en`       | 英語       | `ko`       | 韓国語     |
| `zh`       | 中国語     | `fr`       | フランス語 |
| `es`       | スペイン語 | `de`       | ドイツ語   |

## 🛠️ 開発環境

### 必要な環境

- **Node.js**: 18.0.0 以上
- **パッケージマネージャー**: pnpm (推奨)
- **Google Apps Script**: 翻訳 API エンドポイント

### セットアップ

1. **リポジトリのクローン**

   ```bash
   git clone https://github.com/book000/rss-translator-bridge.git
   cd rss-translator-bridge
   ```

2. **依存関係のインストール**

   ```bash
   pnpm install
   ```

3. **環境変数の設定**

   ```bash
   cp .env.example .env
   # .env ファイルを編集して環境変数を設定
   ```

4. **開発サーバーの起動**
   ```bash
   pnpm dev
   ```

### 環境変数

| 変数名                | 必須 | 説明                               | デフォルト |
| --------------------- | ---- | ---------------------------------- | ---------- |
| `GAS_URL`             | ✅   | Google Apps Script 翻訳 API の URL | -          |
| `PORT`                | ❌   | サーバーポート                     | `3000`     |
| `HOST`                | ❌   | サーバーホスト                     | `0.0.0.0`  |
| `DEFAULT_SOURCE_LANG` | ❌   | デフォルトソース言語               | `auto`     |
| `DEFAULT_TARGET_LANG` | ❌   | デフォルトターゲット言語           | `ja`       |

### 開発コマンド

```bash
# 開発サーバー（ホットリロード）
pnpm dev

# プロダクションビルド
pnpm build

# プロダクションサーバー
pnpm start

# 品質チェック
pnpm lint              # Prettier + ESLint + TypeScript
pnpm lint:prettier     # Prettier チェック
pnpm lint:eslint       # ESLint チェック
pnpm lint:tsc          # TypeScript 型チェック

# 自動修正
pnpm fix               # Prettier + ESLint 自動修正
pnpm fix:prettier      # Prettier 自動修正
pnpm fix:eslint        # ESLint 自動修正

# テスト
pnpm test              # 全テスト実行
pnpm test:watch        # ウォッチモード
pnpm test:coverage     # カバレッジ付きテスト

# 型チェック
pnpm typecheck         # TypeScript 型チェックのみ
```

## 🏗️ アーキテクチャ

### システム構成

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   RSS Client    │───▶│ Translator Bridge│───▶│  Google Apps    │
│  (RSS Reader)   │    │   (Fastify)     │    │     Script      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │ Translated RSS  │
                       │   (XML Output)  │
                       └─────────────────┘
```

### 主要コンポーネント

- **`src/index.ts`**: サーバーの起動
- **`src/app.ts`**: Fastify アプリケーションとルーティング
- **`src/safe-fetch.ts`**: 取得先を検証する RSS 取得処理
- **`src/rss-processor.ts`**: RSS 解析・XML 再構築
- **`src/translator.ts`**: GAS API バッチ翻訳
- **`src/types.ts`**: TypeScript 型定義
- **`src/config.ts`**: 環境変数管理

### データフロー

1. **RSS 取得**: 取得先を検証して外部 RSS フィードを取得し、`rss-parser` で解析
2. **バッチ準備**: タイトル・本文・メタデータを翻訳項目として整理
3. **バッチ翻訳**: GAS API に一括送信して高速翻訳
4. **結果適用**: 翻訳結果を元の RSS 構造に適用
5. **XML 出力**: `xml2js` で RSS XML として再構築・配信

## 🚀 デプロイ

### Vercel デプロイ

1. **Vercel CLI のインストール**

   ```bash
   npm i -g vercel
   ```

2. **デプロイ実行**

   ```bash
   vercel
   ```

3. **環境変数の設定**
   Vercel ダッシュボードで環境変数を設定

### その他のプラットフォーム

- **Netlify**: `netlify.toml` 設定済み
- **Railway**: `railway.json` 設定済み
- **Docker**: `Dockerfile` 提供

## 🧪 テスト

### テスト実行

```bash
# 全テスト実行
pnpm test

# ファイル指定テスト
pnpm test rss-processor.test.ts

# ウォッチモード
pnpm test --watch

# カバレッジ
pnpm test --coverage
```

### テスト構成

- **Unit Tests**: 各コンポーネントの単体テスト
- **Integration Tests**: API エンドポイントの統合テスト
- **Mocking**: axios・外部 API のモック化
- **Coverage**: 高いテストカバレッジを維持

## 📚 API リファレンス

### `GET /`

RSS フィードを翻訳して返すメインエンドポイント

**リクエスト**

```
GET /?url=https://example.com/feed.xml&sourceLang=en&targetLang=ja
```

**レスポンス**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>翻訳されたフィードタイトル</title>
    <description>翻訳された説明</description>
    <item>
      <title>翻訳された記事タイトル</title>
      <description>翻訳された記事内容</description>
    </item>
  </channel>
</rss>
```

### `GET /api` と `GET /api/proxy`

`GET /api` は RSS フィードを翻訳して返すエンドポイントです。`GET /api/proxy?url=...` は翻訳前の元の RSS を取得して返します。

#### 取得先の制限

どちらのエンドポイントも、`url` で指定された宛先に次の制限をかけて取得します。

- `http:` と `https:` だけを許可します。ユーザー情報を含む URL (`http://user:pass@host/`) は拒否します。
- ループバック・プライベート・リンクローカルなどの内部アドレスへの接続を拒否します。ホスト名は、接続に使われる名前解決の結果を検証します。1 つでも内部アドレスがあれば拒否します。
- リダイレクトは最大 5 回まで追従し、リダイレクト先ごとにスキームと宛先を検証します。
- DNS 解決・リダイレクト・本文の受信を合わせて 5 秒でタイムアウトします。
- 展開後の応答サイズは 5 MiB までです。

#### エラーレスポンス

| ステータス | 条件                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| 400        | `url` が未指定、複数指定、または不正なスキーム・内部アドレスなどの宛先 |
| 502        | 応答サイズの上限超過、リダイレクトの回数超過・`Location` なし          |
| 504        | 取得が 5 秒の期限を超えた                                              |
| 500        | 上記以外の取得・解析・翻訳の失敗                                       |

`/api/proxy` は、上流が 2xx 以外を返した場合にそのステータスを返します。

### `GET /health`

ヘルスチェックエンドポイント

**レスポンス**

```json
{
  "status": "ok",
  "timestamp": "2025-06-30T08:00:00.000Z"
}
```

## 🔧 トラブルシューティング

### よくある問題

**Q: 翻訳が失敗する**

- GAS_URL が正しく設定されているか確認
- GAS エンドポイントが正常に動作しているか確認

**Q: RSS フィードが取得できない**

- 対象 URL が有効な RSS フィードか確認
- 内部アドレス (`localhost`、プライベート IP など) は取得できません (400)
- 5 秒以内に応答しない、または 5 MiB を超えるフィードは取得できません (504 / 502)
- CORS 設定を確認

**Q: Vercel で 30 秒タイムアウト**

- バッチサイズを調整（GAS 側のタイムアウト: 25 秒）
- 大きなフィードは分割処理を検討

## 🤝 コントリビューション

1. Fork this repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### 開発ガイドライン

- TypeScript strict モード準拠
- ESLint + Prettier による品質管理
- Jest による包括的なテスト
- Conventional Commits によるコミットメッセージ

## 📄 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) ファイルを参照してください。
