# AGENTS.md

Guidance for AI coding agents working in this repository.

## Language

- All deliverables are written in English: commit messages, PR/Issue titles and bodies, review comments, code comments, JSDoc, test descriptions and documentation.
- Exceptions: localized UI strings (the Japanese text in `public/`), quotations, technical identifiers, generated files, external source text, and test fixtures such as translation samples.
- Runtime messages (logs and errors) are English.
- Never rewrite Git history to change the language of existing commits.

## Overview

A Fastify (TypeScript, ESM) server that translates RSS feeds in batches through a Google Apps Script (GAS) translation API and returns RSS 2.0 XML.
It is deployed to Vercel as a serverless function.
See `README.md` for usage, the API, environment variables and the GAS contract.

## Structure

- `src/index.ts`: starts the server; `getApp()` calls `buildApp()` with `public/` as the static root. Uses `import.meta`, so Jest cannot load it.
- `src/app.ts`: `buildApp()`, the routes (`GET /health`, `GET /api`, `GET /api/proxy`, static `public/`) and the mapping of fetch errors to HTTP statuses.
- `src/safe-fetch.ts`: `safeFetchText()`, the SSRF-safe fetch.
- `src/rss-processor.ts`: feed parsing, translation batching and XML rebuilding.
- `src/translator.ts`: GAS API client with timeouts, fallback to the original text and the cache.
- `src/translation-cache.ts`, `src/cache-control.ts`: translation cache and `Cache-Control` header.
- `src/config.ts`: `loadConfig()`, the single place that reads environment variables. `src/types.ts`: shared types.
- `api/serverless.ts`: Vercel entry point. `public/`: web UI.

## Commands

The package manager is pnpm (`preinstall` enforces it). The Node.js version is in `.node-version`.

```bash
pnpm install
pnpm dev            # tsx watch
pnpm start
pnpm build          # tsc
pnpm lint           # prettier --check, eslint, tsc --noEmit; run before committing
pnpm fix            # prettier --write, eslint --fix
pnpm test           # Jest; pass a file name for one test file
pnpm test -- --coverage
```

## Conventions

- TypeScript strict mode. Avoid `any`, needless `as` assertions and `@ts-ignore`.
- ES modules: relative imports end in `.js` (for example `./types.js`), as the ESM resolution requires.
- Write JSDoc for functions and interfaces, and keep it in sync with the implementation (params, returns, throws).
- Formatting and lint are enforced by Prettier and ESLint (`@book000/eslint-config`).
- Add a new environment variable only in `src/config.ts` (except `NODE_ENV`), and update `.env.example` and the table in `README.md` with it.
- Update `README.md` when the API, environment variables or commands change.
- Commits: [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); branches: [Conventional Branch](https://conventional-branch.github.io) short form (`feat`, `fix`, ...).
- Do not add commits to Renovate-created pull requests.

## Constraints

- Fetch every user-supplied URL with `safeFetchText`; never call `fetch` or `RSSParser.parseURL` on it directly.
  It allows only `http:`/`https:`, rejects internal addresses (validated on the address actually connected to, at every redirect hop), and limits the total time (5 s), decompressed size (5 MiB) and redirects (5).
- Translation failures must fall back to the original text rather than failing the request or returning empty values.
- Fetching, parsing and translating a feed share a 27 s per-request budget (Vercel's 30 s `maxDuration` in `vercel.json` minus 3 s for building and sending the response), set by `REQUEST_BUDGET_MS` in `src/rss-processor.ts`.
  The GAS batch timeout is the smaller of 25 s (`BATCH_TIMEOUT_MS` in `src/translator.ts`) and the budget left after the feed fetch, and it also covers reading the response body.
- Do not hardcode `GAS_URL` or other secrets or personal data in code, logs or tests.

## Tests

- Jest with ts-jest; tests live in `src/__tests__/`.
- Mock external dependencies: the GAS `fetch` call, `rss-parser`, `../safe-fetch` and internal modules via `jest.mock`.
  HTTP is `fetch`, not axios.
- Add tests for new behavior, including error handling and the translation fallback.

## Before a PR

- `pnpm lint` and `pnpm test` pass.
- Documentation matches the change (see Conventions).
- The PR title and body are in English.
