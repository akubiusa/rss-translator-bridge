import fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { loadConfig } from '../config'
import { RSSProcessor } from '../rss-processor'
import { Config, TranslateRequest } from '../types'
import { buildCacheControlHeader } from '../cache-control'

jest.mock('../config')
jest.mock('../rss-processor')

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockRSSProcessor = RSSProcessor as jest.MockedClass<typeof RSSProcessor>

describe('RSS Translator Bridge API', () => {
  let app: FastifyInstance
  let mockRSSProcessorInstance: jest.Mocked<RSSProcessor>

  const createTestApp = async (config: Config) => {
    const testApp = fastify({ logger: false })
    await testApp.register(import('@fastify/cors'), { origin: true })

    const rssProcessor = new RSSProcessor(
      config.gasUrl,
      config.translationCache
    )

    // Health check endpoint
    testApp.get('/health', () => {
      return { status: 'ok', timestamp: new Date().toISOString() }
    })

    // Translation endpoint handler
    const translateHandler = async (
      request: FastifyRequest<{ Querystring: TranslateRequest }>,
      reply: FastifyReply
    ) => {
      const {
        url,
        sourceLang,
        targetLang,
        excludeFeedTitle,
        excludeItemTitle,
      } = request.query

      if (!url) {
        return reply.code(400).send({
          status: 'error',
          error: 'URL parameter is required',
        })
      }

      try {
        const shouldExcludeFeedTitle =
          excludeFeedTitle === 'true' ||
          (excludeFeedTitle === undefined && config.defaultExcludeFeedTitle)

        const shouldExcludeItemTitle =
          excludeItemTitle === 'true' ||
          (excludeItemTitle === undefined && config.defaultExcludeItemTitle)

        const translatedRSS = await rssProcessor.processRSSFeed(
          url,
          sourceLang ?? config.defaultSourceLang ?? 'auto',
          targetLang ?? config.defaultTargetLang ?? 'ja',
          shouldExcludeFeedTitle,
          shouldExcludeItemTitle
        )

        if (!translatedRSS) {
          return await reply.code(500).send({
            status: 'error',
            error: 'Failed to process RSS feed',
          })
        }

        return await reply
          .code(200)
          .header('Content-Type', 'application/rss+xml; charset=utf-8')
          .header('Cache-Control', buildCacheControlHeader(config.cacheControl))
          .send(translatedRSS)
      } catch {
        return await reply.code(500).send({
          status: 'error',
          error: 'Internal server error',
        })
      }
    }

    // Register API route
    testApp.get('/api', translateHandler)

    await testApp.ready()
    return testApp
  }

  beforeEach(async () => {
    mockLoadConfig.mockReturnValue({
      gasUrl: 'https://example.com/gas',
      port: 3000,
      host: '0.0.0.0',
      defaultSourceLang: 'auto',
      defaultTargetLang: 'ja',
      defaultExcludeFeedTitle: true,
      defaultExcludeItemTitle: false,
      translationCache: {
        enabled: true,
        ttlMs: 21_600_000,
        maxItems: 1000,
      },
      cacheControl: {
        enabled: true,
        sMaxAge: 300,
        staleWhileRevalidate: 60,
      },
    })

    mockRSSProcessorInstance = {
      processRSSFeed: jest.fn(),
    } as any

    mockRSSProcessor.mockImplementation(() => mockRSSProcessorInstance)

    const config = mockLoadConfig()
    app = await createTestApp(config)
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body) as {
        status: string
        timestamp: string
      }
      expect(body.status).toBe('ok')
      expect(body.timestamp).toBeDefined()
    })
  })

  describe('GET /api', () => {
    it('should return 400 when URL parameter is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api',
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body) as {
        status: string
        error: string
      }
      expect(body.status).toBe('error')
      expect(body.error).toBe('URL parameter is required')
    })

    it('should process RSS feed successfully', async () => {
      const mockXML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title><![CDATA[テストフィード]]></title>
    <description><![CDATA[テスト説明]]></description>
  </channel>
</rss>`

      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml',
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe(
        'application/rss+xml; charset=utf-8'
      )
      expect(response.headers['cache-control']).toBe(
        buildCacheControlHeader(mockLoadConfig().cacheControl)
      )
      expect(response.body).toBe(mockXML)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'auto',
        'ja',
        true,
        false
      )
    })

    it('should use custom source and target languages', async () => {
      const mockXML = '<rss>translated content</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml&sourceLang=en&targetLang=ko',
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'en',
        'ko',
        true,
        false
      )
    })

    it('should return no-store when CDN cache is disabled', async () => {
      const mockXML = '<rss>cache disabled</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)
      await app.close()
      mockLoadConfig.mockReturnValue({
        gasUrl: 'https://example.com/gas',
        port: 3000,
        host: '0.0.0.0',
        defaultSourceLang: 'auto',
        defaultTargetLang: 'ja',
        defaultExcludeFeedTitle: true,
        defaultExcludeItemTitle: false,
        translationCache: {
          enabled: true,
          ttlMs: 21_600_000,
          maxItems: 1000,
        },
        cacheControl: {
          enabled: false,
          sMaxAge: 300,
          staleWhileRevalidate: 60,
        },
      })
      app = await createTestApp(mockLoadConfig())

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml',
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
    })

    it('should return 500 when RSS processing fails', async () => {
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(null)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/invalid.xml',
      })

      expect(response.statusCode).toBe(500)
      const body = JSON.parse(response.body) as {
        status: string
        error: string
      }
      expect(body.status).toBe('error')
      expect(body.error).toBe('Failed to process RSS feed')
    })

    it('should return 500 when an exception occurs', async () => {
      mockRSSProcessorInstance.processRSSFeed.mockRejectedValue(
        new Error('Unexpected error')
      )

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml',
      })

      expect(response.statusCode).toBe(500)
      const body = JSON.parse(response.body) as {
        status: string
        error: string
      }
      expect(body.status).toBe('error')
      expect(body.error).toBe('Internal server error')
    })

    it('should handle URL encoding properly', async () => {
      const mockXML = '<rss>encoded content</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const encodedUrl = encodeURIComponent(
        'https://example.com/feed with spaces.xml'
      )
      const response = await app.inject({
        method: 'GET',
        url: `/api?url=${encodedUrl}`,
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed with spaces.xml',
        'auto',
        'ja',
        true,
        false
      )
    })

    it('should use excludeFeedTitle parameter when provided', async () => {
      const mockXML = '<rss>translated without feed title</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml&excludeFeedTitle=false',
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'auto',
        'ja',
        false,
        false
      )
    })

    it('should default excludeFeedTitle to true when not provided', async () => {
      const mockXML = '<rss>translated with default settings</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml',
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'auto',
        'ja',
        true,
        false
      )
    })

    it('should use excludeItemTitle parameter when provided as true', async () => {
      const mockXML = '<rss>translated without item titles</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml&excludeItemTitle=true',
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'auto',
        'ja',
        true,
        true
      )
    })

    it('should use excludeItemTitle parameter when provided as false', async () => {
      const mockXML = '<rss>translated with item titles</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml&excludeItemTitle=false',
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'auto',
        'ja',
        true,
        false
      )
    })

    it('should default excludeItemTitle to false when not provided', async () => {
      const mockXML = '<rss>translated with default item title settings</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml',
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'auto',
        'ja',
        true,
        false
      )
    })

    it('should handle both excludeFeedTitle and excludeItemTitle parameters together', async () => {
      const mockXML = '<rss>translated with custom exclusion settings</rss>'
      mockRSSProcessorInstance.processRSSFeed.mockResolvedValue(mockXML)

      const response = await app.inject({
        method: 'GET',
        url: '/api?url=https://example.com/feed.xml&excludeFeedTitle=false&excludeItemTitle=true',
      })

      expect(response.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRSSProcessorInstance.processRSSFeed).toHaveBeenCalledWith(
        'https://example.com/feed.xml',
        'auto',
        'ja',
        false,
        true
      )
    })
  })
})
