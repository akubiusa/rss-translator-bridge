/** @jest-environment jsdom */
/// <reference lib="dom" />

import { readFileSync } from 'node:fs'
import path from 'node:path'

const FEED_URL = 'https://example.com/feed.xml'
const PROXY_URL = `/api/proxy?url=${encodeURIComponent(FEED_URL)}`
const TRANSLATE_URL_PREFIX = `/api?url=${encodeURIComponent(FEED_URL)}`
const PROXY_XML = '<rss><channel><title>Proxy</title></channel></rss>'
const DIRECT_XML = '<rss><channel><title>Direct</title></channel></rss>'
const TRANSLATED_XML = '<rss><channel><title>Translated</title></channel></rss>'
const FETCH_FAILED_MESSAGE = 'Failed to fetch the original RSS feed'
const ORIGINAL_UNAVAILABLE_NOTICE = '元のRSSフィードを取得できませんでした'

type Reply =
  | Error
  | {
      status: number
      statusText?: string
      body?: string
      json?: unknown
      contentType?: string
    }

interface Replies {
  proxy: Reply
  direct: Reply
  translate: Reply
}

// ts-jest runs this file as CommonJS, where `import.meta.dirname` is unavailable.
// eslint-disable-next-line unicorn/prefer-module
const publicDirectory = path.resolve(__dirname, '../../public')
const indexHtml = readFileSync(path.join(publicDirectory, 'index.html'), 'utf8')
const scriptSource = readFileSync(
  path.join(publicDirectory, 'script.js'),
  'utf8'
)

const okTranslation: Reply = {
  status: 200,
  statusText: 'OK',
  body: TRANSLATED_XML,
  contentType: 'application/rss+xml',
}
const failedResponse: Reply = {
  status: 502,
  statusText: 'Bad Gateway',
  body: '',
}

let fetchMock: jest.Mock
let warnSpy: jest.SpyInstance
let errorSpy: jest.SpyInstance

function toResponse(reply: Reply) {
  if (reply instanceof Error) {
    return Promise.reject(reply)
  }
  return Promise.resolve({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    statusText: reply.statusText ?? '',
    text: () => Promise.resolve(reply.body ?? ''),
    json: () => Promise.resolve(reply.json ?? {}),
    headers: { get: () => reply.contentType ?? null },
  })
}

function stubFetch(replies: Replies): void {
  fetchMock = jest.fn((url: string) => {
    if (url.startsWith('/api/proxy?')) return toResponse(replies.proxy)
    if (url.startsWith('/api?')) return toResponse(replies.translate)
    return toResponse(replies.direct)
  })
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    configurable: true,
    writable: true,
  })
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`Element not found: ${selector}`)
  return found
}

function textOf(selector: string): string {
  return element(selector).textContent ?? ''
}

function displayOf(selector: string): string {
  return element(selector).style.display
}

function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))
}

/** Mounts the real page markup and runs the real script exactly once. */
function mountPage(): void {
  const parsed = new DOMParser().parseFromString(indexHtml, 'text/html')
  document.body.innerHTML = parsed.body.innerHTML

  const addListener = document.addEventListener.bind(document)
  let onReady: EventListener | undefined
  jest
    .spyOn(document, 'addEventListener')
    .mockImplementation((type, listener, options) => {
      if (type === 'DOMContentLoaded' && typeof listener === 'function') {
        onReady = listener
        return
      }
      addListener(type, listener, options)
    })

  // jsdom fires the window `load` event after the first test starts, and the
  // page-load performance log it triggers needs APIs jsdom does not implement.
  const addWindowListener = globalThis.addEventListener.bind(globalThis)
  jest
    .spyOn(globalThis, 'addEventListener')
    .mockImplementation((type, listener, options) => {
      if (type !== 'load') addWindowListener(type, listener, options)
    })

  // eslint-disable-next-line no-eval
  globalThis.eval(scriptSource)
  if (!onReady) throw new Error('script.js did not register DOMContentLoaded')
  onReady(new Event('DOMContentLoaded'))
}

async function submitFeed(url: string): Promise<void> {
  Object.assign(element('#rssUrl'), { value: url })
  element('#translateForm').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })
  )
  for (let tick = 0; tick < 50; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!element('#translateBtn').hasAttribute('disabled')) return
  }
  throw new Error('The translation flow did not settle')
}

describe('public/script.js original feed fetch failure handling', () => {
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mountPage()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('shows a failure notice and still displays the translation when both original fetches fail', async () => {
    stubFetch({
      proxy: failedResponse,
      direct: failedResponse,
      translate: okTranslation,
    })

    await submitFeed(FEED_URL)

    const urls = fetchedUrls()
    expect(urls[0]).toBe(PROXY_URL)
    expect(urls[1].startsWith(TRANSLATE_URL_PREFIX)).toBe(true)
    expect(urls[2]).toBe(FEED_URL)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenNthCalledWith(3, FEED_URL, { mode: 'cors' })
    expect(warnSpy).toHaveBeenCalledWith(
      'Original RSS fetch failed:',
      new Error(FETCH_FAILED_MESSAGE)
    )
    expect(textOf('#originalXml code')).toBe(ORIGINAL_UNAVAILABLE_NOTICE)
    expect(textOf('#translatedXml code')).toBe(TRANSLATED_XML)
    expect(displayOf('#resultsSection')).toBe('block')
    expect(displayOf('#errorSection')).toBe('none')
    expect(textOf('#status')).toBe('成功 (HTTP 200)')
  })

  it('shows the same notice when the proxy request rejects and does not retry directly', async () => {
    const networkError = new TypeError('Failed to fetch')
    stubFetch({
      proxy: networkError,
      direct: { status: 200, body: DIRECT_XML },
      translate: okTranslation,
    })

    await submitFeed(FEED_URL)

    expect(fetchedUrls()).not.toContain(FEED_URL)
    expect(warnSpy).toHaveBeenCalledWith(
      'Original RSS fetch failed:',
      networkError
    )
    expect(textOf('#originalXml code')).toBe(ORIGINAL_UNAVAILABLE_NOTICE)
    expect(textOf('#translatedXml code')).toBe(TRANSLATED_XML)
    expect(displayOf('#resultsSection')).toBe('block')
    expect(displayOf('#errorSection')).toBe('none')
  })

  it('shows the directly fetched original feed when only the proxy fails', async () => {
    stubFetch({
      proxy: failedResponse,
      direct: { status: 200, body: DIRECT_XML },
      translate: okTranslation,
    })

    await submitFeed(FEED_URL)

    expect(fetchMock).toHaveBeenCalledWith(FEED_URL, { mode: 'cors' })
    expect(warnSpy).not.toHaveBeenCalled()
    expect(textOf('#originalXml code')).toBe(DIRECT_XML)
    expect(textOf('#translatedXml code')).toBe(TRANSLATED_XML)
  })

  it('shows the proxied original feed without a direct fetch when the proxy succeeds', async () => {
    stubFetch({
      proxy: { status: 200, body: PROXY_XML },
      direct: failedResponse,
      translate: okTranslation,
    })

    await submitFeed(FEED_URL)

    expect(fetchedUrls()).not.toContain(FEED_URL)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(textOf('#originalXml code')).toBe(PROXY_XML)
    expect(textOf('#translatedXml code')).toBe(TRANSLATED_XML)
  })

  it('shows the translation error instead of results when the translation fails too', async () => {
    stubFetch({
      proxy: failedResponse,
      direct: failedResponse,
      translate: {
        status: 500,
        statusText: 'Internal Server Error',
        json: { error: 'Translation backend unavailable' },
      },
    })

    await submitFeed(FEED_URL)

    expect(textOf('#errorMessage')).toBe('Translation backend unavailable')
    expect(displayOf('#errorSection')).toBe('block')
    expect(displayOf('#resultsSection')).toBe('none')
    expect(textOf('#status')).toBe('エラー (HTTP 500)')
    expect(errorSpy).toHaveBeenCalledWith(
      'Translation error:',
      new Error('Translation backend unavailable')
    )
  })
})
