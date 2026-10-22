import { TranslationCache } from '../translation-cache'

describe('TranslationCache', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('should return null when cache entry is expired', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const cache = new TranslationCache({
      enabled: true,
      ttlMs: 1000,
      maxItems: 10,
    })

    cache.set('key', 'value')
    jest.setSystemTime(new Date('2026-01-01T00:00:01.001Z'))

    expect(cache.get('key')).toBeNull()
  })

  it('should evict oldest entry when maxItems is exceeded', () => {
    const cache = new TranslationCache({
      enabled: true,
      ttlMs: 10_000,
      maxItems: 2,
    })

    cache.set('first', '1')
    cache.set('second', '2')
    cache.get('first')
    cache.set('third', '3')

    expect(cache.get('second')).toBeNull()
    expect(cache.get('first')).toBe('1')
    expect(cache.get('third')).toBe('3')
  })

  it('should evict even when oldest key is empty string', () => {
    const cache = new TranslationCache({
      enabled: true,
      ttlMs: 10_000,
      maxItems: 1,
    })

    cache.set('', 'empty')
    cache.set('next', 'value')

    expect(cache.get('')).toBeNull()
    expect(cache.get('next')).toBe('value')
  })
})
