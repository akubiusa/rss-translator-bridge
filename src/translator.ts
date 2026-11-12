import { createHash } from 'node:crypto'
import {
  GASBatchTranslateRequest,
  GASBatchTranslateResponse,
  BatchTranslateItem,
  TranslationCacheConfig,
} from './types.js'
import { TranslationCache } from './translation-cache.js'

/**
 * Translation client for the Google Apps Script (GAS) API.
 *
 * Failures never throw: a failed batch falls back to the original text.
 */
export class Translator {
  private gasUrl: string
  private cache: TranslationCache

  /**
   * @param gasUrl URL of the GAS translation API
   * @param cacheConfig Translation cache settings. The cache is disabled when omitted.
   */
  constructor(gasUrl: string, cacheConfig?: TranslationCacheConfig) {
    this.gasUrl = gasUrl
    this.cache = new TranslationCache(
      cacheConfig ?? { enabled: false, ttlMs: 0, maxItems: 0 }
    )
  }

  /** Builds a cache key from the language pair and a SHA-256 hash of the text. */
  private createCacheKey(
    text: string,
    sourceLang: string,
    targetLang: string
  ): string {
    const hash = createHash('sha256').update(text).digest('hex')
    return `${sourceLang}:${targetLang}:${hash}`
  }

  /**
   * POSTs JSON to the GAS API and aborts the request after `timeoutMs`.
   *
   * @throws {Error} On a non-2xx response or a network error. The timeout covers only the response headers, not reading the body.
   */
  private async postWithTimeout(
    body: unknown,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    let response: Response
    try {
      response = await fetch(this.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const errorBody = await response.text()
      const errorDetail = errorBody ? ` - ${errorBody.slice(0, 1000)}` : ''
      throw new Error(
        `HTTP error: ${response.status} ${response.statusText}${errorDetail}`
      )
    }

    return response
  }

  /**
   * Translates multiple texts in one GAS request, serving cache hits locally.
   *
   * Items GAS reports as failed fall back to their original text. If the whole request fails, every pending item falls back.
   * If GAS does not report success (HTTP 200 with a truthy `status`), the pending items are left out of the returned map.
   *
   * @param items Texts to translate, each with an id
   * @param sourceLang Source language code
   * @param targetLang Target language code
   * @returns Translated (or fallback) text keyed by item id
   */
  async translateBatch(
    items: BatchTranslateItem[],
    sourceLang: string,
    targetLang: string
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>()
    const pendingItems: BatchTranslateItem[] = []
    const cacheKeys = new Map<string, string>()
    const shouldUseCache = this.cache.isEnabled()

    if (shouldUseCache) {
      for (const item of items) {
        const cacheKey = this.createCacheKey(item.text, sourceLang, targetLang)
        const cached = this.cache.get(cacheKey)
        if (cached !== null) {
          results.set(item.id, cached)
          continue
        }
        pendingItems.push(item)
        cacheKeys.set(item.id, cacheKey)
      }
    } else {
      pendingItems.push(...items)
    }

    if (pendingItems.length === 0) {
      return results
    }

    try {
      const request: GASBatchTranslateRequest = {
        batch: true,
        before: sourceLang,
        after: targetLang,
        texts: pendingItems,
        mode: 'html',
      }

      console.log(
        `Sending batch request with ${pendingItems.length} items to GAS`
      )
      console.log(
        'First 3 items:',
        pendingItems
          .slice(0, 3)
          .map((item) => ({ id: item.id, textLength: item.text.length }))
      )

      // 25s leaves headroom under the 30s Vercel function limit (`maxDuration` in vercel.json)
      const response = await this.postWithTimeout(request, 25_000)
      const data = (await response.json()) as GASBatchTranslateResponse

      console.log('GAS Response status:', response.status)
      console.log('GAS Response data:', {
        status: data.status,
        processed: data.processed,
        total: data.total,
        executionTime: data.executionTime,
        resultCount: data.results.length,
      })

      if (response.status === 200 && data.status) {
        console.log(`Processing ${data.results.length} results from GAS`)

        for (const result of data.results) {
          if (result.success && result.translated) {
            results.set(result.id, result.translated)
            if (shouldUseCache) {
              const cacheKey = cacheKeys.get(result.id)
              if (cacheKey) {
                this.cache.set(cacheKey, result.translated)
              }
            }
          } else {
            console.log(`Translation failed for ${result.id}:`, result.error)
            // Fall back to the original text
            results.set(result.id, result.original)
          }
        }
        console.log(
          `Batch translation: ${data.processed}/${data.total} items processed in ${data.executionTime}ms`
        )
        console.log(`Client received ${results.size} translated items`)
      } else {
        console.error('GAS returned error status:', data)
      }
    } catch (error) {
      console.error('Batch translation error:', error)
      // Fall back to the original text
      for (const item of pendingItems) {
        results.set(item.id, item.text)
      }
    }

    return results
  }
}
