# RSS Translator Bridge

A Fastify server that translates RSS feeds.
It fetches a feed, translates its text in batches through a Google Apps Script (GAS) translation API, and returns the result as RSS 2.0 XML.
It also serves a small web UI that shows the original and translated XML.

## Features

- Batch translation: all texts of a feed are sent to GAS in one request.
- Fallback: when a translation fails, the original text is kept.
- HTML-aware: every text is sent to GAS with `mode: "html"`, so markup in `content:encoded`, `description` and similar fields is handled as HTML.
- Caching: translations are cached in memory, and translated responses carry a CDN-oriented `Cache-Control` header.
- SSRF protection: only public `http:`/`https:` destinations are fetched (see [Fetch restrictions](#fetch-restrictions)).
- Serverless: runs on Vercel through `api/serverless.ts`, and as a plain Node.js server through `src/index.ts`.

## Usage

Start the server (see [Development](#development)) and request `/api`:

```
GET /api?url=<feed URL>&sourceLang=<code>&targetLang=<code>
```

For example, to translate an English feed into Japanese:

```bash
curl 'http://localhost:3000/api?url=https%3A%2F%2Fexample.com%2Ffeed.xml&sourceLang=en&targetLang=ja'
```

Opening `/` in a browser shows the web UI instead (`public/`), which calls `/api` and `/api/proxy`.

### Query parameters

| Parameter          | Required | Description                                                                 | Default                                |
| ------------------ | -------- | --------------------------------------------------------------------------- | -------------------------------------- |
| `url`              | Yes      | URL of the feed to translate. Must be given once.                           | -                                      |
| `sourceLang`       | No       | Source language code                                                        | `DEFAULT_SOURCE_LANG` (`auto`)         |
| `targetLang`       | No       | Target language code                                                        | `DEFAULT_TARGET_LANG` (`ja`)           |
| `excludeFeedTitle` | No       | `true` keeps the feed title untranslated. Any other value translates it.    | `DEFAULT_EXCLUDE_FEED_TITLE` (`true`)  |
| `excludeItemTitle` | No       | `true` keeps the item titles untranslated. Any other value translates them. | `DEFAULT_EXCLUDE_ITEM_TITLE` (`false`) |

Language codes are passed to the GAS API unchanged, so the supported values depend on the GAS script.
The web UI offers `en`, `ja`, `ko`, `zh`, `es`, `fr` and `de`, plus `auto` for the source language.

## Development

Requirements:

- Node.js (`engines` requires 18 or later; `.node-version` pins the version used for development)
- pnpm (enforced by a `preinstall` script)
- A deployed Google Apps Script translation API (see [GAS API contract](#gas-api-contract))

```bash
pnpm install
cp .env.example .env   # set GAS_URL
pnpm dev               # tsx watch
```

`pnpm start` runs the server once without watching.
The server reads its settings from environment variables only; it does not load `.env` by itself, so export the variables in your shell before starting it, for example `set -a; source .env; set +a`.

| Command                   | Description                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm dev`                | Start the server with hot reload                                                         |
| `pnpm start`              | Start the server                                                                         |
| `pnpm build`              | Compile with `tsc` to `dist/`                                                            |
| `pnpm lint`               | Run Prettier, ESLint and the TypeScript type check                                       |
| `pnpm fix`                | Run Prettier and ESLint with auto-fix                                                    |
| `pnpm test`               | Run the Jest tests; pass a file name to run one, for example `pnpm test translator.test` |
| `pnpm test -- --coverage` | Run the tests with coverage                                                              |
| `pnpm typecheck`          | Type check only (`tsc --noEmit`)                                                         |

## Configuration

| Variable                           | Required | Description                                                           | Default    |
| ---------------------------------- | -------- | --------------------------------------------------------------------- | ---------- |
| `GAS_URL`                          | Yes      | URL of the GAS translation API. The server fails to start without it. | -          |
| `PORT`                             | No       | Listen port                                                           | `3000`     |
| `HOST`                             | No       | Listen host                                                           | `0.0.0.0`  |
| `DEFAULT_SOURCE_LANG`              | No       | Default for `sourceLang`                                              | `auto`     |
| `DEFAULT_TARGET_LANG`              | No       | Default for `targetLang`                                              | `ja`       |
| `DEFAULT_EXCLUDE_FEED_TITLE`       | No       | Default for `excludeFeedTitle`. Only `false` disables it.             | `true`     |
| `DEFAULT_EXCLUDE_ITEM_TITLE`       | No       | Default for `excludeItemTitle`. Only `true` enables it.               | `false`    |
| `TRANSLATION_CACHE_ENABLED`        | No       | Enable the translation cache. Only `false` disables it.               | `true`     |
| `TRANSLATION_CACHE_TTL_MS`         | No       | Translation cache TTL in milliseconds                                 | `21600000` |
| `TRANSLATION_CACHE_MAX_ITEMS`      | No       | Maximum number of cached translations (LRU eviction)                  | `1000`     |
| `CDN_CACHE_ENABLED`                | No       | Send a CDN `Cache-Control` header. Only `false` disables it.          | `true`     |
| `CDN_CACHE_S_MAXAGE`               | No       | `s-maxage` in seconds                                                 | `300`      |
| `CDN_CACHE_STALE_WHILE_REVALIDATE` | No       | `stale-while-revalidate` in seconds                                   | `60`       |

The translation cache is per process.
Cached entries are keyed by the language pair and a SHA-256 hash of the text.

When the CDN cache is enabled, `/api` success responses carry `Cache-Control: public, max-age=0, s-maxage=<S_MAXAGE>, stale-while-revalidate=<STALE_WHILE_REVALIDATE>`; when disabled they carry `no-store`.
`/api/proxy` sets no `Cache-Control` header.

## API

### `GET /api`

Translates a feed and returns RSS 2.0 XML (`Content-Type: application/rss+xml; charset=utf-8`).

The output contains `title`, `link`, `description`, `language` and `lastBuildDate` for the channel, and `title`, `link`, `description`, `pubDate` and `guid` for each item.
`content:encoded` and `dc:creator` are added to an item only when the source has them.
Item bodies are taken from the first available of `content:encoded`, `content`, `description` and `summary`, and are translated in place.
All items are translated; there is no item limit.

Errors are returned as JSON:

```json
{ "status": "error", "error": "URL parameter is required" }
```

### `GET /api/proxy?url=<feed URL>`

Returns the original, untranslated feed body with `Content-Type: application/rss+xml; charset=utf-8`.
The web UI uses it to show the original feed without hitting CORS restrictions.
Errors are returned as `{ "error": "<message>" }`.
When the upstream responds with a non-2xx status, that status is returned with `Failed to fetch RSS: <status text>`.

### `GET /health`

```json
{ "status": "ok", "timestamp": "2026-01-01T00:00:00.000Z" }
```

### Error statuses

Both `/api` and `/api/proxy` map fetch errors to the following statuses:

| Status | Condition                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | `url` is missing or given more than once, or the destination is rejected (scheme, credentials, address) |
| 502    | The response exceeds the size limit, or a redirect has no `Location` or exceeds the redirect limit      |
| 504    | The fetch exceeds the 5 second deadline                                                                 |
| 500    | Any other fetch or parse failure (translation failures fall back to the original text)                  |

### Fetch restrictions

Every URL is fetched through `src/safe-fetch.ts`, which applies the following to the first request and to each redirect target:

- Only `http:` and `https:` are allowed, and URLs with credentials (`http://user:pass@host/`) are rejected.
- Connections to loopback, private, link-local and other internal addresses are rejected.
  The check runs on the addresses actually used for the connection, and a hostname is rejected if any of its addresses is internal.
- At most 5 redirects are followed.
- DNS resolution, redirects and body download share a 5 second deadline.
- The decompressed response may be at most 5 MiB.
- No headers from the caller (such as `Cookie` or `Authorization`) are forwarded.

## GAS API contract

The server POSTs JSON to `GAS_URL`.
The request and response types are defined in `src/types.ts`.

Batch request (used by `/api`; 25 second timeout):

```json
{
  "batch": true,
  "before": "en",
  "after": "ja",
  "texts": [{ "id": "feed-description", "text": "..." }],
  "mode": "html"
}
```

Batch response:

```json
{
  "status": true,
  "results": [
    {
      "id": "feed-description",
      "original": "...",
      "translated": "...",
      "success": true
    }
  ],
  "processed": 1,
  "total": 1,
  "executionTime": 120
}
```

Items with `success: false` fall back to their original text.
If the request fails entirely (network error, timeout, non-2xx), every pending item falls back to its original text and `/api` still returns the feed.

## Architecture

```
Client -> GET /api -> RSSProcessor -> safeFetchText -> source feed
                          |
                          +-> Translator -> GAS API (batch, cached)
                          |
                          +-> xml2js -> translated RSS XML
```

| File                       | Role                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`             | Starts the server and exposes `getApp()`                             |
| `src/app.ts`               | Fastify app, routes and error-to-status mapping                      |
| `src/safe-fetch.ts`        | SSRF-safe fetch                                                      |
| `src/rss-processor.ts`     | Feed parsing (`rss-parser`), translation batching and XML rebuilding |
| `src/translator.ts`        | GAS API client with timeout, fallback and cache                      |
| `src/translation-cache.ts` | In-memory LRU cache with TTL                                         |
| `src/cache-control.ts`     | `Cache-Control` header builder                                       |
| `src/config.ts`            | Environment variable loading                                         |
| `src/types.ts`             | Shared types                                                         |
| `api/serverless.ts`        | Vercel entry point                                                   |
| `public/`                  | Web UI                                                               |

## Deployment

The repository is set up for Vercel: `vercel.json` routes every path to `api/serverless.ts` and sets `maxDuration` to 30 seconds.
Set `GAS_URL` (and any other variables) in the Vercel project settings, then deploy with the Vercel CLI (`vercel`).
The GAS batch timeout (25 seconds) is chosen to fit within that 30 second limit, so very large feeds can still time out.

The in-memory translation cache only lives as long as a function instance.

## Tests

Jest with ts-jest; tests are in `src/__tests__/`.
External dependencies (the GAS `fetch` call, `rss-parser`, `safeFetchText`) are mocked.
CI (`.github/workflows/ci.yml`) runs lint and tests through a reusable workflow from `book000/templates`.

## License

This project is licensed under the [MIT License](LICENSE).
