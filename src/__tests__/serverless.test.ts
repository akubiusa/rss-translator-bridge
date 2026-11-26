import { createServer, get } from 'node:http'
import { AddressInfo } from 'node:net'
import handler from '../../api/serverless.js'
import { getApp } from '../../src/index.js'

jest.mock('../../src/index.js', () => ({ getApp: jest.fn() }))

jest.mock('../../src/safe-fetch.js', () => ({
  safeFetchText: jest.fn(() =>
    Promise.resolve(
      '<rss version="2.0"><channel><title>Feed</title><link>https://example.com</link><description>Original description</description></channel></rss>'
    )
  ),
  FetchTimeoutError: class FetchTimeoutError extends Error {},
  HttpStatusError: class HttpStatusError extends Error {},
  RedirectError: class RedirectError extends Error {},
  ResponseTooLargeError: class ResponseTooLargeError extends Error {},
  UnsafeUrlError: class UnsafeUrlError extends Error {},
}))

/** A minimal stand-in for the Fastify instance used by the handler. */
function createFakeApp(ready: () => Promise<void> = () => Promise.resolve()) {
  return {
    ready: jest.fn(ready),
    close: jest.fn(() => Promise.resolve()),
    server: { emit: jest.fn() },
  }
}

/** Loads a fresh handler module so its cached app starts empty. */
async function loadHandler() {
  const handlerModule = await import('../../api/serverless.js')
  const indexModule = await import('../../src/index.js')
  return {
    handler: handlerModule.default,
    mockGetApp: jest.mocked(indexModule.getApp),
  }
}

const call = (handler: Awaited<ReturnType<typeof loadHandler>>['handler']) =>
  handler({} as never, {} as never)

describe('serverless handler', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('reuses the app and its translation cache across requests', async () => {
    const mockGetApp = jest.mocked(getApp)
    mockGetApp.mockImplementation(async () => {
      const { buildApp } = await import('../../src/app.js')
      return buildApp()
    })

    const gasFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          results: [
            {
              id: 'feed-description',
              original: 'Original description',
              translated: 'Translated description',
              success: true,
            },
          ],
          processed: 1,
          total: 1,
          executionTime: 1,
        }),
        { status: 200 }
      )
    )

    const server = createServer((req, res) => {
      handler(req, res).catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)))
      })
    })

    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      const { port } = server.address() as AddressInfo

      const request = () =>
        new Promise<string>((resolve, reject) => {
          get(
            `http://127.0.0.1:${port}/api?url=https%3A%2F%2Fexample.com%2Ffeed.xml`,
            (response) => {
              let body = ''
              response.setEncoding('utf8')
              response.on('data', (chunk: string) => {
                body += chunk
              })
              response.on('end', () => {
                resolve(body)
              })
            }
          ).on('error', reject)
        })

      const firstResponse = await request()
      const secondResponse = await request()

      expect(firstResponse).toContain('Translated description')
      expect(secondResponse).toContain('Translated description')
      expect(mockGetApp).toHaveBeenCalledTimes(1)
      expect(gasFetch).toHaveBeenCalledTimes(1)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
      gasFetch.mockRestore()
    }
  })

  describe('initialization', () => {
    it('shares one initialization between concurrent requests', async () => {
      const { handler, mockGetApp } = await loadHandler()
      const app = createFakeApp()
      mockGetApp.mockResolvedValue(app as never)

      await Promise.all([call(handler), call(handler), call(handler)])

      expect(mockGetApp).toHaveBeenCalledTimes(1)
      expect(app.ready).toHaveBeenCalledTimes(1)
      expect(app.server.emit).toHaveBeenCalledTimes(3)
    })

    it('retries after getApp fails', async () => {
      const { handler, mockGetApp } = await loadHandler()
      const app = createFakeApp()
      mockGetApp
        .mockRejectedValueOnce(new Error('build failed'))
        .mockResolvedValueOnce(app as never)

      await expect(call(handler)).rejects.toThrow('build failed')
      await call(handler)
      await call(handler)

      expect(mockGetApp).toHaveBeenCalledTimes(2)
      expect(app.server.emit).toHaveBeenCalledTimes(2)
    })

    it('closes the app and retries after ready fails', async () => {
      const { handler, mockGetApp } = await loadHandler()
      const failing = createFakeApp(() =>
        Promise.reject(new Error('not ready'))
      )
      const healthy = createFakeApp()
      mockGetApp
        .mockResolvedValueOnce(failing as never)
        .mockResolvedValueOnce(healthy as never)

      await expect(call(handler)).rejects.toThrow('not ready')
      expect(failing.close).toHaveBeenCalledTimes(1)
      expect(failing.server.emit).not.toHaveBeenCalled()

      await call(handler)

      expect(mockGetApp).toHaveBeenCalledTimes(2)
      expect(healthy.server.emit).toHaveBeenCalledTimes(1)
    })
  })
})
