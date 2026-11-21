import { IncomingMessage, ServerResponse } from 'node:http'
import { getApp } from '../src/index.js'

let appPromise: ReturnType<typeof getApp> | undefined

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
) {
  appPromise ??= getApp()
  const app = await appPromise
  await app.ready()
  app.server.emit('request', req, res)
}
