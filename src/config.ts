import { Config } from './types.js'

/** 環境変数から設定を読み込む。 */
export function loadConfig(): Config {
  const gasUrl = process.env.GAS_URL
  if (!gasUrl) {
    throw new Error('GAS_URL environment variable is required')
  }

  const translationCacheEnabled =
    process.env.TRANSLATION_CACHE_ENABLED !== 'false'
  const translationCacheTtlMs = Number.parseInt(
    process.env.TRANSLATION_CACHE_TTL_MS ?? '21600000',
    10
  )
  const translationCacheMaxItems = Number.parseInt(
    process.env.TRANSLATION_CACHE_MAX_ITEMS ?? '1000',
    10
  )

  const cacheControlEnabled = process.env.CDN_CACHE_ENABLED !== 'false'
  const cacheControlSMaxAge = Number.parseInt(
    process.env.CDN_CACHE_S_MAXAGE ?? '300',
    10
  )
  const cacheControlStaleWhileRevalidate = Number.parseInt(
    process.env.CDN_CACHE_STALE_WHILE_REVALIDATE ?? '60',
    10
  )

  return {
    gasUrl,
    port: Number.parseInt(process.env.PORT ?? '3000', 10),
    host: process.env.HOST ?? '0.0.0.0',
    defaultSourceLang: process.env.DEFAULT_SOURCE_LANG ?? 'auto',
    defaultTargetLang: process.env.DEFAULT_TARGET_LANG ?? 'ja',
    defaultExcludeFeedTitle: process.env.DEFAULT_EXCLUDE_FEED_TITLE !== 'false',
    defaultExcludeItemTitle: process.env.DEFAULT_EXCLUDE_ITEM_TITLE === 'true',
    translationCache: {
      enabled: translationCacheEnabled,
      ttlMs: translationCacheTtlMs,
      maxItems: translationCacheMaxItems,
    },
    cacheControl: {
      enabled: cacheControlEnabled,
      sMaxAge: cacheControlSMaxAge,
      staleWhileRevalidate: cacheControlStaleWhileRevalidate,
    },
  }
}
