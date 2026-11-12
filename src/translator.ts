import { createHash } from 'node:crypto'
import {
  GASBatchTranslateRequest,
  GASBatchTranslateResponse,
  BatchTranslateItem,
  TranslationCacheConfig,
} from './types.js'
import { TranslationCache } from './translation-cache.js'

/** Default upper bound in milliseconds for one GAS batch request. */
export const BATCH_TIMEOUT_MS = 25_000

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
   * POSTs JSON to the GAS API and parses the JSON response, aborting everything after `timeoutMs`.
   *
   * @param body Request payload, serialized as JSON
   * @param timeoutMs Upper bound in milliseconds for the whole exchange: headers, body read and JSON parsing
   * @returns The HTTP status and the parsed response body, which the caller must validate or cast
   * @throws {Error} On a non-2xx response, a network error, a timeout or an invalid JSON body
   */
  private async postWithTimeout(
    body: unknown,
    timeoutMs: number
  ): Promise<{ status: number; data: unknown }> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      const response = await fetch(this.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = await response.text()
        const errorDetail = errorBody ? ` - ${errorBody.slice(0, 1000)}` : ''
        throw new Error(
          `HTTP error: ${response.status} ${response.statusText}${errorDetail}`
        )
      }

      return { status: response.status, data: await response.json() }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Translates multiple texts in one GAS request, serving cache hits locally.
   *
   * Items GAS reports as failed fall back to their original text. If the whole request fails, or GAS does not report success (HTTP 200 with a truthy `status`), every pending item falls back.
   *
   * @param items Texts to translate, each with an id
   * @param sourceLang Source language code
   * @param targetLang Target language code
   * @param timeoutMs Upper bound in milliseconds for the GAS request, including reading the response. When 0 or less, GAS is not called and every uncached item falls back to its original text.
   * @returns Translated (or fallback) text keyed by item id
   */
  async translateBatch(
    items: BatchTranslateItem[],
    sourceLang: string,
    targetLang: string,
    timeoutMs = BATCH_TIMEOUT_MS
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

    if (timeoutMs <= 0) {
      for (const item of pendingItems) {
        results.set(item.id, item.text)
      }
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

      const { status, data: responseBody } = await this.postWithTimeout(
        request,
        timeoutMs
      )
      const data = responseBody as GASBatchTranslateResponse

      console.log('GAS Response status:', status)
      console.log('GAS Response data:', {
        status: data.status,
        processed: data.processed,
        total: data.total,
        executionTime: data.executionTime,
        resultCount: data.results.length,
      })

      if (status === 200 && data.status) {
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
        for (const item of pendingItems) {
          results.set(item.id, item.text)
        }
      }
    } catch (error) {
      console.error('Batch translation error:', error)
      for (const item of pendingItems) {
        results.set(item.id, item.text)
      }
    }

    return results
  }
}
