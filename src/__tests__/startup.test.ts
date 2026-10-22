import fastify from 'fastify'
import cors from '@fastify/cors'
import { loadConfig } from '../config.js'
import { RSSProcessor } from '../rss-processor.js'
import { TranslateRequest, TranslateResponse } from '../types.js'
import { buildCacheControlHeader } from '../cache-control.js'

// 起動テスト用の設定を追加
process.env.NODE_ENV = 'test'

// テスト用の軽量なgetApp関数
async function getTestApp() {
  const config = loadConfig()
  const app = fastify({
    logger: false, // テスト時はログを無効
  })

  // Register CORS
  await app.register(cors, {
    origin: true,
  })

  // staticプラグインはテスト環境では登録しない

  const rssProcessor = new RSSProcessor(config.gasUrl, config.translationCache)

  // Health check endpoint
  app.get('/health', () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  // Proxy endpoint for fetching original RSS (CORS workaround)
  app.get<{
    Querystring: { url: string }
  }>('/api/proxy', async (request, reply) => {
    const { url } = request.query

    if (!url) {
      return reply.code(400).send({ error: 'URL parameter is required' })
    }

    try {
      const response = await fetch(url)
      if (!response.ok) {
        return await reply
          .code(response.status)
          .send({ error: `Failed to fetch RSS: ${response.statusText}` })
      }

      const rssContent = await response.text()
      return await reply
        .code(200)
        .header('Content-Type', 'application/rss+xml; charset=utf-8')
        .send(rssContent)
    } catch (error) {
      app.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch original RSS' })
    }
  })

  // Main RSS translation API endpoint
  app.get<{
    Querystring: TranslateRequest
  }>('/api', async (request, reply) => {
    const { url, sourceLang, targetLang } = request.query

    if (!url) {
      const response: TranslateResponse = {
        status: 'error',
        error: 'URL parameter is required',
      }
      return reply.code(400).send(response)
    }

    try {
      const translatedRSS = await rssProcessor.processRSSFeed(
        url,
        sourceLang ?? config.defaultSourceLang ?? 'auto',
        targetLang ?? config.defaultTargetLang ?? 'ja'
      )

      if (!translatedRSS) {
        const response: TranslateResponse = {
          status: 'error',
          error: 'Failed to process RSS feed',
        }
        return await reply.code(500).send(response)
      }

      // Return translated RSS as XML
      return await reply
        .code(200)
        .header('Content-Type', 'application/rss+xml; charset=utf-8')
        .header('Cache-Control', buildCacheControlHeader(config.cacheControl))
        .send(translatedRSS)
    } catch (error) {
      app.log.error(error)
      const response: TranslateResponse = {
        status: 'error',
        error: 'Internal server error',
      }
      return await reply.code(500).send(response)
    }
  })

  return app
}

describe('Application Startup', () => {
  it('should start server without errors', async () => {
    const app = await getTestApp()

    try {
      await app.ready()

      // アプリケーションが正常に起動できることを確認
      expect(app).toBeDefined()
      expect(app.server).toBeDefined()

      // プラグインが正常に登録されていることを確認
      expect(app.hasPlugin('@fastify/cors')).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('should register all required routes', async () => {
    const app = await getTestApp()

    try {
      await app.ready()

      // 必要なルートが登録されていることを確認
      const routes = app.printRoutes({ commonPrefix: false })

      expect(routes).toContain('/health (GET, HEAD)')
      expect(routes).toContain('/proxy (GET, HEAD)')
      expect(routes).toContain('/api (GET, HEAD)')
    } finally {
      await app.close()
    }
  })

  it('should handle health check endpoint', async () => {
    const app = await getTestApp()

    try {
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/health',
      })

      expect(response.statusCode).toBe(200)

      const body = JSON.parse(response.body)
      expect(body).toHaveProperty('status', 'ok')
      expect(body).toHaveProperty('timestamp')
    } finally {
      await app.close()
    }
  })

  it('should handle missing URL parameter for API endpoint', async () => {
    const app = await getTestApp()

    try {
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/api',
      })

      expect(response.statusCode).toBe(400)

      const body = JSON.parse(response.body)
      expect(body).toHaveProperty('status', 'error')
      expect(body).toHaveProperty('error', 'URL parameter is required')
    } finally {
      await app.close()
    }
  })

  it('should handle missing URL parameter for proxy endpoint', async () => {
    const app = await getTestApp()

    try {
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/api/proxy',
      })

      expect(response.statusCode).toBe(400)

      const body = JSON.parse(response.body)
      expect(body).toHaveProperty('error', 'URL parameter is required')
    } finally {
      await app.close()
    }
  })

  it('should properly configure CORS', async () => {
    const app = await getTestApp()

    try {
      await app.ready()

      const response = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'GET',
        },
      })

      expect(response.statusCode).toBe(204)
      expect(response.headers['access-control-allow-origin']).toBe(
        'https://example.com'
      )
    } finally {
      await app.close()
    }
  })
})
