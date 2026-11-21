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

describe('serverless handler', () => {
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
})
