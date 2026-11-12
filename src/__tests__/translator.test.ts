import { Translator } from '../translator'
import { BatchTranslateItem } from '../types'

function mockFetchResponse(status: number, data: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: jest.fn().mockResolvedValue(data),
    text: jest.fn().mockResolvedValue(''),
  } as unknown as Response
}

describe('Translator - Batch Translation', () => {
  let translator: Translator
  let mockedFetch: jest.MockedFunction<typeof fetch>

  beforeEach(() => {
    translator = new Translator('https://example.com/translate')
    mockedFetch = jest.fn()
    jest.spyOn(globalThis, 'fetch').mockImplementation(mockedFetch)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const mockBatchItems: BatchTranslateItem[] = [
    { id: 'item1', text: 'Hello' },
    { id: 'item2', text: 'World' },
    { id: 'item3', text: 'How are you?' },
  ]

  it('should translate batch items successfully', async () => {
    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(200, {
        status: true,
        processed: 3,
        total: 3,
        executionTime: 500,
        results: [
          {
            id: 'item1',
            success: true,
            original: 'Hello',
            translated: 'こんにちは',
          },
          { id: 'item2', success: true, original: 'World', translated: '世界' },
          {
            id: 'item3',
            success: true,
            original: 'How are you?',
            translated: '元気ですか？',
          },
        ],
      })
    )

    const result = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(3)
    expect(result.get('item1')).toBe('こんにちは')
    expect(result.get('item2')).toBe('世界')
    expect(result.get('item3')).toBe('元気ですか？')
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://example.com/translate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch: true,
          before: 'en',
          after: 'ja',
          texts: mockBatchItems,
          mode: 'html',
        }),
      })
    )
  })

  it('should handle partial translation failures', async () => {
    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(200, {
        status: true,
        processed: 2,
        total: 3,
        executionTime: 500,
        results: [
          {
            id: 'item1',
            success: true,
            original: 'Hello',
            translated: 'こんにちは',
          },
          {
            id: 'item2',
            success: false,
            original: 'World',
            error: 'Translation failed',
          },
          {
            id: 'item3',
            success: true,
            original: 'How are you?',
            translated: '元気ですか？',
          },
        ],
      })
    )

    const result = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(result.size).toBe(3)
    expect(result.get('item1')).toBe('こんにちは')
    expect(result.get('item2')).toBe('World') // fallback to original
    expect(result.get('item3')).toBe('元気ですか？')
  })

  it('should handle empty batch items', async () => {
    const result = await translator.translateBatch([], 'en', 'ja')

    expect(result.size).toBe(0)
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('should return original texts on network error', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('Network error'))

    const result = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(result.size).toBe(3)
    expect(result.get('item1')).toBe('Hello') // fallback to original
    expect(result.get('item2')).toBe('World') // fallback to original
    expect(result.get('item3')).toBe('How are you?') // fallback to original
  })

  it('should return fallback texts on non-2xx HTTP status', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      // no-op
    })
    mockedFetch.mockResolvedValueOnce(mockFetchResponse(500, {}))

    const result = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(result.size).toBe(3) // HTTP error triggers fallback
    expect(result.get('item1')).toBe('Hello')
    expect(result.get('item2')).toBe('World')
    expect(result.get('item3')).toBe('How are you?')
    consoleSpy.mockRestore()
  })

  it('should return fallback texts when response status is false', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      // no-op
    })
    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(200, {
        status: false,
        processed: 0,
        total: 3,
        executionTime: 0,
        results: [],
      })
    )

    const result = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(result.size).toBe(3)
    expect(result.get('item1')).toBe('Hello')
    expect(result.get('item2')).toBe('World')
    expect(result.get('item3')).toBe('How are you?')
    consoleSpy.mockRestore()
  })

  it('should return fallback texts on a non-200 2xx response', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      // no-op
    })
    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(204, {
        status: true,
        processed: 0,
        total: 3,
        executionTime: 0,
        results: [],
      })
    )

    const result = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(result.size).toBe(3)
    expect(result.get('item1')).toBe('Hello')
    expect(result.get('item2')).toBe('World')
    expect(result.get('item3')).toBe('How are you?')
    consoleSpy.mockRestore()
  })

  it('should return fallback texts on HTTP error response', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      // no-op
    })
    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(429, { error: 'Rate limit exceeded' })
    )

    const result = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(result.size).toBe(3)
    expect(result.get('item1')).toBe('Hello')
    expect(consoleSpy).toHaveBeenCalledWith(
      'Batch translation error:',
      expect.any(Error)
    )

    consoleSpy.mockRestore()
  })

  it('should handle large batch efficiently', async () => {
    const largeBatch: BatchTranslateItem[] = Array.from(
      { length: 100 },
      (_, i) => ({ id: `item${i}`, text: `Text ${i}` })
    )

    const mockResults = largeBatch.map((item) => ({
      id: item.id,
      success: true,
      original: item.text,
      translated: `翻訳 ${item.text}`,
    }))

    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(200, {
        status: true,
        processed: 100,
        total: 100,
        executionTime: 2000,
        results: mockResults,
      })
    )

    const result = await translator.translateBatch(largeBatch, 'en', 'ja')

    expect(result.size).toBe(100)
    expect(result.get('item0')).toBe('翻訳 Text 0')
    expect(result.get('item99')).toBe('翻訳 Text 99')
  })

  it('should use cached batch results on repeated calls', async () => {
    translator = new Translator('https://example.com/translate', {
      enabled: true,
      ttlMs: 60_000,
      maxItems: 100,
    })
    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(200, {
        status: true,
        processed: 3,
        total: 3,
        executionTime: 500,
        results: [
          {
            id: 'item1',
            success: true,
            original: 'Hello',
            translated: 'こんにちは',
          },
          { id: 'item2', success: true, original: 'World', translated: '世界' },
          {
            id: 'item3',
            success: true,
            original: 'How are you?',
            translated: '元気ですか？',
          },
        ],
      })
    )

    const first = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(first.get('item1')).toBe('こんにちは')
    expect(first.get('item2')).toBe('世界')
    expect(first.get('item3')).toBe('元気ですか？')

    mockedFetch.mockClear()

    const second = await translator.translateBatch(mockBatchItems, 'en', 'ja')

    expect(second.get('item1')).toBe('こんにちは')
    expect(second.get('item2')).toBe('世界')
    expect(second.get('item3')).toBe('元気ですか？')
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})

function rejectOnAbort(signal: AbortSignal | null | undefined) {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new Error('aborted'))
    })
  })
}

function stalledBodyResponse(
  status: number,
  signal: AbortSignal | null | undefined
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Stalled',
    json: () => rejectOnAbort(signal),
    text: () => rejectOnAbort(signal),
  } as unknown as Response
}

function expectOriginalText(result: Map<string, string>) {
  expect(result.get('item1')).toBe('Hello')
  expect(result.get('item2')).toBe('World')
}

describe('Translator - Batch timeout', () => {
  const items: BatchTranslateItem[] = [
    { id: 'item1', text: 'Hello' },
    { id: 'item2', text: 'World' },
  ]
  let translator: Translator
  let mockedFetch: jest.MockedFunction<typeof fetch>

  beforeEach(() => {
    jest.useFakeTimers()
    translator = new Translator('https://example.com/translate')
    mockedFetch = jest.fn()
    jest.spyOn(globalThis, 'fetch').mockImplementation(mockedFetch)
    jest.spyOn(console, 'log').mockImplementation(() => {
      // no-op
    })
    jest.spyOn(console, 'error').mockImplementation(() => {
      // no-op
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('should abort the request after the given timeout and fall back to the original text', async () => {
    mockedFetch.mockImplementation((_url, init) => rejectOnAbort(init?.signal))

    const promise = translator.translateBatch(items, 'en', 'ja', 1000)
    await jest.advanceTimersByTimeAsync(999)
    expect(mockedFetch.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(1)

    expectOriginalText(await promise)
    expect(mockedFetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('should abort when the response body never arrives', async () => {
    mockedFetch.mockImplementation((_url, init) =>
      Promise.resolve(stalledBodyResponse(200, init?.signal))
    )

    const promise = translator.translateBatch(items, 'en', 'ja', 1000)
    await jest.advanceTimersByTimeAsync(1000)

    expectOriginalText(await promise)
  })

  it('should abort when the error response body never arrives', async () => {
    mockedFetch.mockImplementation((_url, init) =>
      Promise.resolve(stalledBodyResponse(500, init?.signal))
    )

    const promise = translator.translateBatch(items, 'en', 'ja', 1000)
    await jest.advanceTimersByTimeAsync(1000)

    expectOriginalText(await promise)
  })

  it('should default to a 25 second timeout', async () => {
    mockedFetch.mockImplementation((_url, init) => rejectOnAbort(init?.signal))

    const promise = translator.translateBatch(items, 'en', 'ja')
    await jest.advanceTimersByTimeAsync(24_999)
    expect(mockedFetch.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(1)

    expectOriginalText(await promise)
  })

  it('should not call GAS when the timeout is 0 and fall back to the original text', async () => {
    const result = await translator.translateBatch(items, 'en', 'ja', 0)

    expect(mockedFetch).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
    expectOriginalText(result)
  })

  it('should still serve cache hits when the timeout is 0', async () => {
    translator = new Translator('https://example.com/translate', {
      enabled: true,
      ttlMs: 60_000,
      maxItems: 10,
    })
    mockedFetch.mockResolvedValueOnce(
      mockFetchResponse(200, {
        status: true,
        processed: 1,
        total: 1,
        executionTime: 1,
        results: [
          {
            id: 'item1',
            success: true,
            original: 'Hello',
            translated: 'こんにちは',
          },
        ],
      })
    )
    await translator.translateBatch([items[0]], 'en', 'ja')
    mockedFetch.mockClear()

    const result = await translator.translateBatch(items, 'en', 'ja', 0)

    expect(mockedFetch).not.toHaveBeenCalled()
    expect(result.get('item1')).toBe('こんにちは')
    expect(result.get('item2')).toBe('World')
  })
})
