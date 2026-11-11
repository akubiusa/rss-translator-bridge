import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const currentFilename = fileURLToPath(import.meta.url)
const currentDirname = path.dirname(currentFilename)

/**
 * Creates the Fastify app, serving `public/` as static files.
 *
 * @returns The Fastify instance
 */
export async function getApp() {
  return buildApp({ staticRoot: path.join(currentDirname, '../public') })
}

/** Loads the config and starts listening. */
async function start() {
  const config = loadConfig()
  const app = await getApp()

  try {
    await app.listen({
      port: config.port ?? 3000,
      host: config.host ?? '0.0.0.0',
    })
    app.log.info(`Server listening on ${config.host}:${config.port}`)
  } catch (error) {
    app.log.error(error)
    throw new Error('Failed to start server')
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((error: unknown) => {
    console.error('Failed to start server:', error)
    throw error
  })
}
