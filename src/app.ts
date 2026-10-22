import fastify, { FastifyRequest, FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import staticPlugin from '@fastify/static'
import { loadConfig } from './config.js'
import { RSSProcessor } from './rss-processor.js'
import { buildCacheControlHeader } from './cache-control.js'
import {
  FetchTimeoutError,
  HttpStatusError,
  RedirectError,
  ResponseTooLargeError,
  safeFetchText,
  UnsafeUrlError,
} from './safe-fetch.js'
import { TranslateRequest, TranslateResponse } from './types.js'

/**
 * buildApp のオプション
 */
export interface BuildAppOptions {
  /** 静的ファイルの配信元。テスト環境では指定しても配信しない */
  staticRoot?: string
}

/**
 * url クエリパラメータの不備を返す
 *
 * Fastify は同じキーが複数あると配列で渡すため、文字列であることも確認する。
 *
 * @param url url クエリパラメータ
 * @returns 不備があればエラーメッセージ、なければ undefined
 */
function getUrlParameterError(url: unknown): string | undefined {
  if (url === undefined || url === '') {
    return 'URL parameter is required'
  }
  if (typeof url !== 'string') {
    return 'URL parameter must be a single string'
  }
  return undefined
}

/**
 * 取得処理のエラーを HTTP ステータスとメッセージに対応付ける
 *
 * @param error 取得処理で発生したエラー
 * @returns 対応付けたステータスとメッセージ。個別に扱わないエラーは undefined
 */
function toHttpError(
  error: unknown
): { statusCode: number; message: string } | undefined {
  if (error instanceof UnsafeUrlError) {
    return { statusCode: 400, message: error.message }
  }
  if (error instanceof FetchTimeoutError) {
    return { statusCode: 504, message: error.message }
  }
  if (
    error instanceof ResponseTooLargeError ||
    error instanceof RedirectError
  ) {
    return { statusCode: 502, message: error.message }
  }
  return undefined
}

/**
 * Fastify アプリケーションを組み立てる
 *
 * @param options 静的ファイルの配信元などのオプション
 * @returns 組み立てた Fastify インスタンス
 */
export async function buildApp(options: BuildAppOptions = {}) {
  const config = loadConfig()
  const app = fastify({
    logger: true,
  })

  // Register CORS
  await app.register(cors, {
    origin: true,
  })

  // Register static files (skip in test environment)
  if (process.env.NODE_ENV !== 'test' && options.staticRoot) {
    await app.register(staticPlugin, {
      root: options.staticRoot,
      prefix: '/',
    })
  }

  const rssProcessor = new RSSProcessor(config.gasUrl, config.translationCache)

  // 拒否した宛先の IP は応答に含めず、サーバー側のログにだけ残す
  const logBlockedDestination = (error: unknown) => {
    if (error instanceof UnsafeUrlError && error.address) {
      app.log.warn({ address: error.address }, error.message)
    }
  }

  // Health check endpoint
  app.get('/health', () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  // Proxy endpoint for fetching original RSS (CORS workaround)
  app.get<{
    Querystring: { url: string }
  }>('/api/proxy', async (request, reply) => {
    const { url } = request.query

    const urlError = getUrlParameterError(url)
    if (urlError) {
      return reply.code(400).send({ error: urlError })
    }

    try {
      const rssContent = await safeFetchText(url)
      return await reply
        .code(200)
        .header('Content-Type', 'application/rss+xml; charset=utf-8')
        .send(rssContent)
    } catch (error) {
      if (error instanceof HttpStatusError) {
        return await reply
          .code(error.status)
          .send({ error: `Failed to fetch RSS: ${error.statusText}` })
      }
      const httpError = toHttpError(error)
      if (httpError) {
        logBlockedDestination(error)
        return await reply
          .code(httpError.statusCode)
          .send({ error: httpError.message })
      }
      app.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch original RSS' })
    }
  })

  // Main RSS translation endpoint handler
  /** RSS 翻訳 API を処理する。 */
  const translateHandler = async (
    request: FastifyRequest<{ Querystring: TranslateRequest }>,
    reply: FastifyReply
  ) => {
    const { url, sourceLang, targetLang, excludeFeedTitle, excludeItemTitle } =
      request.query

    const urlError = getUrlParameterError(url)
    if (urlError) {
      const response: TranslateResponse = {
        status: 'error',
        error: urlError,
      }
      return reply.code(400).send(response)
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
      const httpError = toHttpError(error)
      if (httpError) {
        logBlockedDestination(error)
        const response: TranslateResponse = {
          status: 'error',
          error: httpError.message,
        }
        return await reply.code(httpError.statusCode).send(response)
      }
      app.log.error(error)
      const response: TranslateResponse = {
        status: 'error',
        error: 'Internal server error',
      }
      return await reply.code(500).send(response)
    }
  }

  // Main RSS translation API endpoint
  app.get<{
    Querystring: TranslateRequest
  }>('/api', translateHandler)

  return app
}
