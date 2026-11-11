# Copilot Code Review Instructions

Read `AGENTS.md` for the repository overview, constraints and conventions.
This file is only a review checklist.

## Language

- Review comments, code comments, JSDoc and documentation are written in English.
- Flag newly added Japanese outside localized UI strings, quotations, technical identifiers and test fixtures.

## Review focus

- Translation failures fall back to the original text; flag changes that return empty values, `undefined` or swallow errors silently.
- GAS timeouts (batch 25 s, single 5 s) stay within Vercel's 30 s limit (`vercel.json`); flag changes that raise them or remove the `AbortController`.
- User-supplied URLs are fetched only through `safeFetchText`; flag direct `fetch` or `RSSParser.parseURL` on them, and any weakening of its checks.
- Flag new `any`, needless `as` assertions and `@ts-ignore`.
- New environment variables are read only in `src/config.ts` and documented in `.env.example` and `README.md`.
- Translation cache (`src/translation-cache.ts`): check key generation, TTL and max-size handling for boundary bugs.
- No secrets (`GAS_URL`, tokens), personal data or internal URLs in code, logs or tests.
- New behavior and bug fixes come with tests in `src/__tests__/`.

## Not issues

- `.js` extensions on relative imports are correct for ESM.
- `npx only-allow pnpm` in `preinstall` is intentional.
- Returning the original text on translation failure is the specified fallback, not a bug.
- Formatting and lint issues are enforced by Prettier and ESLint in CI.
