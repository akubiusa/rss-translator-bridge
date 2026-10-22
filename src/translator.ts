import { createHash } from 'node:crypto'
import {
  GASTranslateRequest,
  GASBatchTranslateRequest,
  GASBatchTranslateResponse,
  BatchTranslateItem,
  TranslationCacheConfig,
} from './types.js'
import { TranslationCache } from './translation-cache.js'

export class Translator {
  private gasUrl: string
  private cache: TranslationCache

  /** 翻訳クライアントを初期化する。 */
  constructor(gasUrl: string, cacheConfig?: TranslationCacheConfig) {
    this.gasUrl = gasUrl
    this.cache = new TranslationCache(
      cacheConfig ?? { enabled: false, ttlMs: 0, maxItems: 0 }
    )
  }

  /** 翻訳キャッシュのキーを生成する。 */
  private createCacheKey(
    text: string,
    sourceLang: string,
    targetLang: string
  ): string {
    const hash = createHash('sha256').update(text).digest('hex')
    return `${sourceLang}:${targetLang}:${hash}`
  }

  /** タイムアウト付きで GAS に JSON POST し、レスポンスを返す。 */
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

  /** 複数テキストをまとめて翻訳する。 */
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

      // 25 seconds timeout for batch processing (within Vercel's 30s limit)
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
            // フォールバック：元のテキストを使用
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
      // フォールバック：元のテキストを使用
      for (const item of pendingItems) {
        results.set(item.id, item.text)
      }
    }

    return results
  }

  /** 単一テキストを翻訳する。 */
  async translate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<string | null> {
    const shouldUseCache = this.cache.isEnabled()
    const cacheKey = shouldUseCache
      ? this.createCacheKey(text, sourceLang, targetLang)
      : ''

    if (shouldUseCache) {
      const cached = this.cache.get(cacheKey)
      if (cached !== null) {
        return cached
      }
    }

    try {
      const request: GASTranslateRequest = {
        before: sourceLang,
        after: targetLang,
        text,
        mode: 'html',
      }

      // 5 seconds timeout for Vercel compatibility
      const response = await this.postWithTimeout(request, 5000)
      const data = (await response.json()) as {
        response?: { status?: boolean; result?: string }
      }

      if (response.status === 200 && data.response?.status) {
        const translated = data.response.result ?? null
        if (translated !== null && shouldUseCache) {
          this.cache.set(cacheKey, translated)
        }
        return translated
      }

      return null
    } catch (error) {
      console.error('Translation error:', error)
      return null
    }
  }
}
