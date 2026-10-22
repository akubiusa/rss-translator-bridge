import { TranslationCacheConfig } from './types.js'

/** 翻訳キャッシュのエントリー。 */
interface CacheEntry {
  value: string
  expiresAt: number
}

/** 翻訳結果を保持する LRU キャッシュ。 */
export class TranslationCache {
  private store = new Map<string, CacheEntry>()

  /** 翻訳キャッシュを初期化する。 */
  constructor(private config: TranslationCacheConfig) {}

  /** キャッシュが有効かどうかを判定する。 */
  isEnabled(): boolean {
    if (!this.config.enabled) {
      return false
    }
    if (
      !Number.isFinite(this.config.ttlMs) ||
      !Number.isFinite(this.config.maxItems)
    ) {
      return false
    }
    return this.config.ttlMs > 0 && this.config.maxItems > 0
  }

  /** キャッシュから翻訳結果を取得する。 */
  get(key: string): string | null {
    if (!this.config.enabled) {
      return null
    }
    if (
      !Number.isFinite(this.config.ttlMs) ||
      !Number.isFinite(this.config.maxItems)
    ) {
      return null
    }

    const entry = this.store.get(key)
    if (!entry) {
      return null
    }

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key)
      return null
    }

    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  /** キャッシュに翻訳結果を保存する。 */
  set(key: string, value: string): void {
    if (!this.config.enabled) {
      return
    }

    if (
      !Number.isFinite(this.config.ttlMs) ||
      !Number.isFinite(this.config.maxItems)
    ) {
      return
    }

    if (this.config.ttlMs <= 0 || this.config.maxItems <= 0) {
      return
    }

    const expiresAt = Date.now() + this.config.ttlMs
    this.store.delete(key)
    this.store.set(key, { value, expiresAt })
    this.evictIfNeeded()
  }

  /** LRU に基づいて古いエントリーを削除する。 */
  private evictIfNeeded(): void {
    if (this.store.size <= this.config.maxItems) {
      return
    }

    const overflow = this.store.size - this.config.maxItems
    for (let i = 0; i < overflow; i += 1) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.store.delete(oldestKey)
    }
  }
}
