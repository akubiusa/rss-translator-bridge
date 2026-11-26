import { IncomingMessage, ServerResponse } from 'node:http'
import { getApp } from '../src/index.js'

type App = Awaited<ReturnType<typeof getApp>>

let appPromise: Promise<App> | undefined

/**
 * Builds the app and waits until it is ready to serve requests.
 *
 * @returns The ready Fastify instance
 * @throws If building or readying the app fails; a half-initialized app is closed first
 */
async function initApp(): Promise<App> {
  const app = await getApp()
  try {
    await app.ready()
  } catch (error) {
    await app.close().catch(() => undefined)
    throw error
  }
  return app
}

/**
 * Returns the app shared by this instance's requests.
 *
 * Concurrent callers share one in-flight initialization, and a successful app
 * is kept so its translation cache survives across requests. A failed
 * initialization is dropped so the next request retries it.
 *
 * @returns The ready Fastify instance
 */
function getReadyApp(): Promise<App> {
  appPromise ??= initApp().catch((error: unknown) => {
    appPromise = undefined
    throw error
  })
  return appPromise
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
) {
  const app = await getReadyApp()
  app.server.emit('request', req, res)
}
