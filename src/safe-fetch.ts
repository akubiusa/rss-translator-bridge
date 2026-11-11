import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { pipeline, Writable } from 'node:stream'
import zlib from 'node:zlib'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const BLOCKED_IPV4_SUBNETS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

// Do not register ::ffff:0:0/96 (IPv4-mapped) here.
// BlockList matches IPv4 addresses internally as IPv4-mapped, so registering it would match every IPv4 address, public ones included.
// IPv4-mapped addresses are rejected separately by isIPv4MappedAddress.
const BLOCKED_IPV6_SUBNETS: [string, number][] = [
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]

const blockList = new net.BlockList()
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  blockList.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  blockList.addSubnet(network, prefix, 'ipv6')
}

/** Base class of the errors thrown by `safeFetchText`. */
export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The scheme, credentials or destination failed validation.
 *
 * The message never contains the resolved IP. It is kept in `address` and only logged server-side.
 */
export class UnsafeUrlError extends SafeFetchError {
  readonly address?: string

  constructor(message: string, address?: string) {
    super(message)
    this.address = address
  }
}

/** Too many redirects, or a redirect without a `Location` header. */
export class RedirectError extends SafeFetchError {}

/** The total deadline was exceeded. */
export class FetchTimeoutError extends SafeFetchError {}

/** The decompressed response exceeded the size limit. */
export class ResponseTooLargeError extends SafeFetchError {}

/** The upstream responded with a non-2xx status. */
export class HttpStatusError extends SafeFetchError {
  readonly status: number
  readonly statusText: string

  constructor(status: number, statusText: string) {
    super(`Upstream responded with status ${status}`)
    this.status = status
    this.statusText = statusText
  }
}

/** Options for `safeFetchText`. */
export interface SafeFetchOptions {
  /** Total deadline in milliseconds covering DNS resolution, all redirect hops and receiving the body. Default 5000. */
  timeoutMs?: number
  /** Maximum decompressed response size in bytes. Default 5 MiB. */
  maxBytes?: number
  /** Maximum number of redirects to follow. Default 5. */
  maxRedirects?: number
  /** Underlying resolver wrapped by the validating lookup. Replaced in tests. */
  lookup?: net.LookupFunction
  /** Blocked-address check. Replaced in tests. */
  isBlockedAddress?: (address: string) => boolean
}

const defaultLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, callback)
}

/**
 * Returns whether an IPv6 address is IPv4-mapped (`::ffff:x:y`).
 *
 * @param address IPv6 address
 * @returns True if IPv4-mapped
 */
function isIPv4MappedAddress(address: string): boolean {
  const normalized = new URL(`http://[${address}]/`).hostname
  return /^\[::ffff:[\da-f]{1,4}(:[\da-f]{1,4})?\]$/.test(normalized)
}

/**
 * Decodes the body using the `charset` of the Content-Type header.
 *
 * Falls back to UTF-8 when no charset is given or the label is unsupported.
 *
 * @param body Decompressed body
 * @param contentType Content-Type header
 * @returns The decoded body
 */
function decodeBody(body: Buffer, contentType: string | undefined): string {
  const label = /charset\s*=\s*["']?([^\s"';]+)/i.exec(contentType ?? '')?.[1]
  if (label) {
    try {
      return new TextDecoder(label).decode(body)
    } catch (error) {
      // Fall back to UTF-8 only for unsupported labels; rethrow anything else
      if (
        (error as NodeJS.ErrnoException).code !== 'ERR_ENCODING_NOT_SUPPORTED'
      ) {
        throw error
      }
    }
  }
  return new TextDecoder().decode(body)
}

/**
 * Returns whether connecting to an address is forbidden.
 *
 * Strings that are not valid IPs (including those with a zone ID) are treated as blocked.
 *
 * @param address IPv4 or IPv6 address
 * @returns True if blocked
 */
export function isBlockedAddress(address: string): boolean {
  if (address.includes('%')) {
    return true
  }
  const family = net.isIP(address)
  if (family === 4) {
    return blockList.check(address, 'ipv4')
  }
  if (family === 6) {
    return isIPv4MappedAddress(address) || blockList.check(address, 'ipv6')
  }
  return true
}

/**
 * Creates a lookup that validates the resolution result used for the actual connection.
 *
 * Resolving and validating separately beforehand would allow DNS rebinding (the result changing after validation), so the lookup that the connection uses is the one validated.
 * Every resolved address must be allowed, otherwise the lookup fails.
 *
 * @param resolve Underlying resolver
 * @param isBlocked Blocked-address check
 * @returns A function for the `lookup` option of `http(s).request`
 */
export function createGuardedLookup(
  resolve: net.LookupFunction,
  isBlocked: (address: string) => boolean
): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, resolved, family) => {
      if (error) {
        callback(error, '', 0)
        return
      }
      const addresses =
        typeof resolved === 'string'
          ? [{ address: resolved, family: family ?? net.isIP(resolved) }]
          : resolved
      const blocked = addresses.find((entry) => isBlocked(entry.address))
      if (blocked) {
        const blockedError = new UnsafeUrlError(
          `Blocked destination: ${hostname}`,
          blocked.address
        ) as unknown as NodeJS.ErrnoException
        callback(blockedError, '', 0)
        return
      }
      if (options.all) {
        callback(null, addresses)
        return
      }
      callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

/**
 * Parses a URL and validates its scheme, credentials and IP literal.
 *
 * Lookup is not called for IP-literal hosts, so they are validated here.
 *
 * @param rawUrl URL string to fetch
 * @param base URL used to resolve a relative URL
 * @param isBlocked Blocked-address check
 * @returns The validated URL
 * @throws {UnsafeUrlError} When the URL is invalid or not allowed
 */
function parseAndValidateUrl(
  rawUrl: string,
  base: URL | undefined,
  isBlocked: (address: string) => boolean
): URL {
  let target: URL
  try {
    target = new URL(rawUrl, base)
  } catch {
    throw new UnsafeUrlError('Invalid URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new UnsafeUrlError(`Unsupported URL scheme: ${target.protocol}`)
  }
  if (target.username !== '' || target.password !== '') {
    throw new UnsafeUrlError('URL must not contain credentials')
  }
  const hostname = target.hostname.startsWith('[')
    ? target.hostname.slice(1, -1)
    : target.hostname
  if (net.isIP(hostname) !== 0 && isBlocked(hostname)) {
    throw new UnsafeUrlError(`Blocked destination: ${hostname}`, hostname)
  }
  return target
}

/**
 * Fetches the body of a URL, connecting only to public destinations (SSRF protection).
 *
 * The scheme and destination IP are validated at every hop (the first URL and each redirect target).
 * No caller-supplied headers such as Cookie or Authorization are sent.
 *
 * @param url URL to fetch
 * @param options Limits and test overrides
 * @returns The body, decoded with the response charset (UTF-8 by default)
 * @throws {SafeFetchError} For rejected destinations, timeouts, oversized responses, redirect errors, unsupported content encodings and non-2xx responses. Network and decompression errors propagate as they are.
 */
export function safeFetchText(
  url: string,
  options: SafeFetchOptions = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const isBlocked = options.isBlockedAddress ?? isBlockedAddress
  const guardedLookup = createGuardedLookup(
    options.lookup ?? defaultLookup,
    isBlocked
  )

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let currentRequest: http.ClientRequest | undefined
    let currentResponse: http.IncomingMessage | undefined

    let timer: NodeJS.Timeout | undefined

    function fail(error: Error): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      currentRequest?.destroy()
      currentResponse?.destroy()
      reject(error)
    }

    function succeed(body: string): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(body)
    }

    function startTimer(): void {
      timer = setTimeout(() => {
        fail(new FetchTimeoutError(`Fetch timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }

    function handleResponse(
      response: http.IncomingMessage,
      target: URL,
      redirectsLeft: number,
      follow: (next: URL, redirectsLeft: number) => void
    ): void {
      currentResponse = response
      const status = response.statusCode ?? 0

      if (REDIRECT_STATUSES.has(status)) {
        // Destroy rather than resume, so the socket is not kept open for a peer that keeps sending a body
        response.destroy()
        const location = response.headers.location
        if (!location) {
          fail(new RedirectError(`Redirect without Location: ${target.host}`))
          return
        }
        if (redirectsLeft <= 0) {
          fail(new RedirectError(`Too many redirects: ${target.host}`))
          return
        }
        try {
          const next = parseAndValidateUrl(location, target, isBlocked)
          follow(next, redirectsLeft - 1)
        } catch (error) {
          fail(error as Error)
        }
        return
      }

      if (status < 200 || status >= 300) {
        response.destroy()
        fail(new HttpStatusError(status, response.statusMessage ?? ''))
        return
      }

      // Early rejection by compressed size. The decompressed byte count is authoritative
      const contentLength = Number(response.headers['content-length'])
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        fail(
          new ResponseTooLargeError(
            `Response exceeds ${maxBytes} bytes: ${target.host}`
          )
        )
        return
      }

      // A decompressor errors on empty input even if a bodiless response carries a Content-Encoding
      const hasBody =
        status !== 204 && response.headers['content-length'] !== '0'
      const encoding = hasBody
        ? (response.headers['content-encoding'] ?? '').trim().toLowerCase()
        : ''
      let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null =
        null
      switch (encoding) {
        case '':
        case 'identity': {
          break
        }
        case 'gzip':
        case 'x-gzip': {
          decoder = zlib.createGunzip()
          break
        }
        case 'deflate': {
          decoder = zlib.createInflate()
          break
        }
        case 'br': {
          decoder = zlib.createBrotliDecompress()
          break
        }
        default: {
          fail(new SafeFetchError(`Unsupported content encoding: ${encoding}`))
          return
        }
      }

      const chunks: Buffer[] = []
      let received = 0
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          if (received > maxBytes) {
            callback(
              new ResponseTooLargeError(
                `Response exceeds ${maxBytes} bytes: ${target.host}`
              )
            )
            return
          }
          chunks.push(chunk)
          callback()
        },
      })
      const onComplete = (error: Error | null): void => {
        if (error) {
          fail(error)
          return
        }
        // An exception thrown in a pipeline callback never reaches the Promise, so treat it as a failure here
        try {
          succeed(
            decodeBody(Buffer.concat(chunks), response.headers['content-type'])
          )
        } catch (decodeError) {
          fail(decodeError as Error)
        }
      }
      if (decoder) {
        pipeline(response, decoder, sink, onComplete)
      } else {
        pipeline(response, sink, onComplete)
      }
    }

    function sendRequest(target: URL, redirectsLeft: number): void {
      const client = target.protocol === 'https:' ? https : http
      const request = client.request(
        target,
        {
          method: 'GET',
          // A keep-alive socket that is reused skips lookup and would bypass validation
          agent: false,
          lookup: guardedLookup,
          headers: {
            Accept:
              'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'rss-translator-bridge',
          },
        },
        (response) => {
          handleResponse(response, target, redirectsLeft, sendRequest)
        }
      )
      currentRequest = request
      request.on('error', (error) => {
        // Ignore errors from a stale request after moving on to the next hop
        if (currentRequest === request) {
          fail(error)
        }
      })
      request.end()
    }

    startTimer()
    try {
      sendRequest(parseAndValidateUrl(url, undefined, isBlocked), maxRedirects)
    } catch (error) {
      fail(error as Error)
    }
  })
}
