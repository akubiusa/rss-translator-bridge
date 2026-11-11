import { TranslationCacheConfig } from './types.js'

/** A cached translation and its expiry time (epoch milliseconds). */
interface CacheEntry {
  value: string
  expiresAt: number
}

/**
 * In-memory LRU cache with a TTL for translation results.
 *
 * Map insertion order is the recency order: `get` and `set` re-insert the key, so the first key is the least recently used.
 * Invalid settings (non-finite or non-positive TTL/size) disable the cache.
 */
export class TranslationCache {
  private store = new Map<string, CacheEntry>()

  constructor(private config: TranslationCacheConfig) {}

  /** Returns whether the cache is enabled and its settings are valid. */
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

  /** Returns the cached translation, or null on a miss or when expired. A hit refreshes recency. */
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

  /** Stores a translation, then evicts the least recently used entries beyond `maxItems`. */
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
