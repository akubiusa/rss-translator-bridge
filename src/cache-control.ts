import { CacheControlConfig } from './types.js'

/** Normalizes a Cache-Control duration to a non-negative integer number of seconds. */
function normalizeCacheSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.floor(value)
}

/**
 * Builds the `Cache-Control` header value for translated responses.
 *
 * @param cacheControl CDN cache settings
 * @returns `no-store` when disabled, otherwise a CDN-oriented value (`max-age=0` keeps browsers revalidating)
 */
export function buildCacheControlHeader(
  cacheControl: CacheControlConfig
): string {
  if (!cacheControl.enabled) {
    return 'no-store'
  }

  const sMaxAge = normalizeCacheSeconds(cacheControl.sMaxAge)
  const staleWhileRevalidate = normalizeCacheSeconds(
    cacheControl.staleWhileRevalidate
  )

  return `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`
}
