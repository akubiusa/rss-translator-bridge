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

// ::ffff:0:0/96 (IPv4-mapped) は登録しない。BlockList は IPv4 を内部で IPv4-mapped
// として照合するため、登録すると公開 IPv4 を含むすべての IPv4 が一致してしまう。
// IPv4-mapped は isIPv4MappedAddress で別途拒否する。
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
  ['ff00::', 8],
]

const blockList = new net.BlockList()
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  blockList.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  blockList.addSubnet(network, prefix, 'ipv6')
}

/**
 * 取得処理の基底エラー
 */
export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * スキーム・資格情報・宛先の検証で拒否されたことを表すエラー
 *
 * message には解決された IP を含めない。IP は address に保持し、サーバー側のログにだけ出す。
 */
export class UnsafeUrlError extends SafeFetchError {
  readonly address?: string

  constructor(message: string, address?: string) {
    super(message)
    this.address = address
  }
}

/**
 * リダイレクトの回数超過、または Location ヘッダーがないことを表すエラー
 */
export class RedirectError extends SafeFetchError {}

/**
 * 総タイムアウトを超過したことを表すエラー
 */
export class FetchTimeoutError extends SafeFetchError {}

/**
 * 展開後の応答サイズが上限を超えたことを表すエラー
 */
export class ResponseTooLargeError extends SafeFetchError {}

/**
 * 上流が 2xx 以外のステータスを返したことを表すエラー
 */
export class HttpStatusError extends SafeFetchError {
  readonly status: number
  readonly statusText: string

  constructor(status: number, statusText: string) {
    super(`Upstream responded with status ${status}`)
    this.status = status
    this.statusText = statusText
  }
}

/**
 * safeFetchText の動作を調整するオプション
 */
export interface SafeFetchOptions {
  /** DNS 解決・全リダイレクトホップ・本文受信完了までの総期限 (ミリ秒) */
  timeoutMs?: number
  /** 展開後の応答サイズの上限 (バイト) */
  maxBytes?: number
  /** 追従するリダイレクトの最大回数 */
  maxRedirects?: number
  /** 検証ラッパーが包む下位のリゾルバー。テストで差し替える */
  lookup?: net.LookupFunction
  /** 禁止アドレスの判定。テストで差し替える */
  isBlockedAddress?: (address: string) => boolean
}

const defaultLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, callback)
}

/**
 * IPv4-mapped IPv6 アドレス (::ffff:x:y) かどうかを判定する
 *
 * @param address IPv6 アドレス
 * @returns IPv4-mapped なら true
 */
function isIPv4MappedAddress(address: string): boolean {
  const normalized = new URL(`http://[${address}]/`).hostname
  return /^\[::ffff:[\da-f]{1,4}(:[\da-f]{1,4})?\]$/.test(normalized)
}

/**
 * 接続を禁止するアドレスかどうかを判定する
 *
 * IP として不正な文字列 (ゾーン ID 付きを含む) も禁止側に倒す。
 *
 * @param address IPv4 または IPv6 アドレス
 * @returns 禁止アドレスなら true
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
 * 接続時の名前解決結果を検証する lookup を作る
 *
 * 事前に別途名前解決して検証すると、検証後に解決結果が変わる DNS リバインディングが
 * 成立するため、実際の接続に使われる解決結果そのものを検証する。
 *
 * @param resolve 下位のリゾルバー
 * @param isBlocked 禁止アドレスの判定
 * @returns http(s).request の lookup オプションに渡す関数
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
 * 取得先の URL を解析し、スキーム・資格情報・IP リテラルを検証する
 *
 * IP リテラルのホストでは lookup が呼ばれないため、ここで検証する。
 *
 * @param rawUrl 取得先の URL 文字列
 * @param base 相対 URL の解決に使う URL
 * @param isBlocked 禁止アドレスの判定
 * @returns 検証済みの URL
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
 * 公開された宛先にだけ接続して URL の本文を取得する
 *
 * 各ホップ (最初の URL とすべてのリダイレクト先) で、スキーム・宛先 IP を検証する。
 * Cookie や Authorization など呼び出し元由来のヘッダーは送らない。
 *
 * @param url 取得先の URL
 * @param options 上限やテスト用の差し替え
 * @returns UTF-8 として解釈した本文
 * @throws {SafeFetchError} 検証の拒否、タイムアウト、サイズ超過、リダイレクト異常、非 2xx 応答
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
        // resume ではなく destroy で破棄する。本文を返し続ける相手にソケットを開けたままにしない
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

      // 圧縮後のサイズによる早期拒否。判定の正は展開後のバイト数
      const contentLength = Number(response.headers['content-length'])
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        fail(
          new ResponseTooLargeError(
            `Response exceeds ${maxBytes} bytes: ${target.host}`
          )
        )
        return
      }

      const encoding = (response.headers['content-encoding'] ?? '')
        .trim()
        .toLowerCase()
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
        succeed(Buffer.concat(chunks).toString('utf8'))
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
          // キープアライブの再利用ソケットでは lookup が呼ばれず、検証を迂回されるため
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
        // 次のホップへ進んだ後の古いリクエストのエラーは無視する
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
