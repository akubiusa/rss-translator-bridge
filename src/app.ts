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

/** Options for `buildApp`. */
export interface BuildAppOptions {
  /** Directory served as static files. Ignored when `NODE_ENV` is `test`. */
  staticRoot?: string
}

/**
 * Validates the `url` query parameter.
 *
 * Fastify passes a repeated key as an array, so the type is checked as well.
 *
 * @param url The `url` query parameter
 * @returns An error message if invalid, otherwise undefined
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
 * Maps a fetch error to an HTTP status and message.
 *
 * @param error The error thrown while fetching
 * @returns The status and message, or undefined for errors handled generically
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
 * Builds the Fastify app with its routes.
 *
 * @param options Build options such as the static file root
 * @returns The Fastify instance
 * @throws {Error} When `GAS_URL` is not set
 */
export async function buildApp(options: BuildAppOptions = {}) {
  const config = loadConfig()
  const app = fastify({
    logger: true,
  })

  await app.register(cors, {
    origin: true,
  })

  // Static files are skipped under test
  if (process.env.NODE_ENV !== 'test' && options.staticRoot) {
    await app.register(staticPlugin, {
      root: options.staticRoot,
      prefix: '/',
    })
  }

  const rssProcessor = new RSSProcessor(config.gasUrl, config.translationCache)

  // The blocked destination IP is logged server-side only and never included in responses
  const logBlockedDestination = (error: unknown) => {
    if (error instanceof UnsafeUrlError && error.address) {
      app.log.warn({ address: error.address }, error.message)
    }
  }

  app.get('/health', () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  // Returns the original RSS so the web UI can show it without hitting CORS
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

  /** Handles `GET /api`: translates the feed and returns it as RSS XML, or maps the error to a status. */
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

  app.get<{
    Querystring: TranslateRequest
  }>('/api', translateHandler)

  return app
}
