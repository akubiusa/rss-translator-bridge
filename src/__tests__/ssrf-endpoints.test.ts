import { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import {
  FetchTimeoutError,
  HttpStatusError,
  RedirectError,
  ResponseTooLargeError,
  safeFetchText,
} from '../safe-fetch'

jest.mock('../safe-fetch', () => {
  const actual =
    jest.requireActual<typeof import('../safe-fetch')>('../safe-fetch')
  return { ...actual, safeFetchText: jest.fn(actual.safeFetchText) }
})

const actualSafeFetchText =
  jest.requireActual<typeof import('../safe-fetch')>(
    '../safe-fetch'
  ).safeFetchText
const mockSafeFetchText = safeFetchText as jest.MockedFunction<
  typeof safeFetchText
>

const ENDPOINTS = [
  {
    path: '/api/proxy',
    errorBody: (error: string) => ({ error }),
  },
  {
    path: '/api',
    errorBody: (error: string) => ({ status: 'error', error }),
  },
]

describe('SSRF protection on the real app', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockSafeFetchText.mockReset()
    mockSafeFetchText.mockImplementation(actualSafeFetchText)
  })

  describe.each(ENDPOINTS)('GET $path', ({ path, errorBody }) => {
    const get = (query: string) =>
      app.inject({ method: 'GET', url: `${path}?${query}` })

    it.each([
      ['http://127.0.0.1/', 'Blocked destination: 127.0.0.1'],
      [
        'http://169.254.169.254/latest/meta-data/',
        'Blocked destination: 169.254.169.254',
      ],
      ['http://10.0.0.1:8080/', 'Blocked destination: 10.0.0.1'],
      ['http://[::1]/', 'Blocked destination: ::1'],
      ['http://localhost:9/', 'Blocked destination: localhost'],
      ['file:///etc/passwd', 'Unsupported URL scheme: file:'],
      ['ftp://example.com/feed.xml', 'Unsupported URL scheme: ftp:'],
      ['http://user:secret@example.com/', 'URL must not contain credentials'],
    ])('%s を 400 で拒否する', async (target, message) => {
      const response = await get(`url=${encodeURIComponent(target)}`)

      expect(response.statusCode).toBe(400)
      expect(JSON.parse(response.body)).toEqual(errorBody(message))
    })

    it('url が未指定なら 400', async () => {
      const response = await get('')

      expect(response.statusCode).toBe(400)
      expect(JSON.parse(response.body)).toEqual(
        errorBody('URL parameter is required')
      )
    })

    it('url が複数指定されて配列になる場合は 400 で、取得を行わない', async () => {
      const response = await get(
        `url=${encodeURIComponent('http://example.com/a')}&url=${encodeURIComponent('http://example.com/b')}`
      )

      expect(response.statusCode).toBe(400)
      expect(JSON.parse(response.body)).toEqual(
        errorBody('URL parameter must be a single string')
      )
      expect(mockSafeFetchText).not.toHaveBeenCalled()
    })

    it('タイムアウトは 504 を返す', async () => {
      mockSafeFetchText.mockRejectedValue(
        new FetchTimeoutError('Fetch timed out after 5000ms')
      )

      const response = await get(
        `url=${encodeURIComponent('https://example.com/feed.xml')}`
      )

      expect(response.statusCode).toBe(504)
      expect(JSON.parse(response.body)).toEqual(
        errorBody('Fetch timed out after 5000ms')
      )
    })

    it('応答サイズの上限超過は 502 を返す', async () => {
      mockSafeFetchText.mockRejectedValue(
        new ResponseTooLargeError('Response exceeds 5242880 bytes: example.com')
      )

      const response = await get(
        `url=${encodeURIComponent('https://example.com/feed.xml')}`
      )

      expect(response.statusCode).toBe(502)
      expect(JSON.parse(response.body)).toEqual(
        errorBody('Response exceeds 5242880 bytes: example.com')
      )
    })

    it('リダイレクトの異常は 502 を返す', async () => {
      mockSafeFetchText.mockRejectedValue(
        new RedirectError('Too many redirects: example.com')
      )

      const response = await get(
        `url=${encodeURIComponent('https://example.com/feed.xml')}`
      )

      expect(response.statusCode).toBe(502)
      expect(JSON.parse(response.body)).toEqual(
        errorBody('Too many redirects: example.com')
      )
    })
  })

  describe('上流のエラー応答', () => {
    it('/api/proxy は上流のステータスをそのまま返す', async () => {
      mockSafeFetchText.mockRejectedValue(new HttpStatusError(404, 'Not Found'))

      const response = await app.inject({
        method: 'GET',
        url: `/api/proxy?url=${encodeURIComponent('https://example.com/missing.xml')}`,
      })

      expect(response.statusCode).toBe(404)
      expect(JSON.parse(response.body)).toEqual({
        error: 'Failed to fetch RSS: Not Found',
      })
    })

    it('/api は従来どおり 500 を返す', async () => {
      mockSafeFetchText.mockRejectedValue(new HttpStatusError(404, 'Not Found'))
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {
        // no-op
      })

      const response = await app.inject({
        method: 'GET',
        url: `/api?url=${encodeURIComponent('https://example.com/missing.xml')}`,
      })

      expect(response.statusCode).toBe(500)
      expect(JSON.parse(response.body)).toEqual({
        status: 'error',
        error: 'Failed to process RSS feed',
      })
      consoleSpy.mockRestore()
    })

    it('/api/proxy は接続失敗などを 500 で返す', async () => {
      mockSafeFetchText.mockRejectedValue(new Error('connect ECONNREFUSED'))

      const response = await app.inject({
        method: 'GET',
        url: `/api/proxy?url=${encodeURIComponent('https://example.com/feed.xml')}`,
      })

      expect(response.statusCode).toBe(500)
      expect(JSON.parse(response.body)).toEqual({
        error: 'Failed to fetch original RSS',
      })
    })
  })

  describe('公開 RSS の取得', () => {
    it('/api/proxy は取得した本文をそのまま返す', async () => {
      mockSafeFetchText.mockResolvedValue('<rss version="2.0"></rss>')

      const response = await app.inject({
        method: 'GET',
        url: `/api/proxy?url=${encodeURIComponent('https://example.com/feed.xml')}`,
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe(
        'application/rss+xml; charset=utf-8'
      )
      expect(response.body).toBe('<rss version="2.0"></rss>')
      expect(mockSafeFetchText).toHaveBeenCalledWith(
        'https://example.com/feed.xml'
      )
    })
  })
})
