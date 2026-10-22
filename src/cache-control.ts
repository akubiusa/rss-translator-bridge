import { CacheControlConfig } from './types.js'

/** Cache-Control の秒数を正規化する。 */
function normalizeCacheSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.floor(value)
}

/** Cache-Control ヘッダーを生成する。 */
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
