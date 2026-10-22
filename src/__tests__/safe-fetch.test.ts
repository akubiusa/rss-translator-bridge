import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import {
  createGuardedLookup,
  FetchTimeoutError,
  HttpStatusError,
  isBlockedAddress,
  RedirectError,
  ResponseTooLargeError,
  safeFetchText,
  SafeFetchError,
  UnsafeUrlError,
} from '../safe-fetch'

interface ReceivedRequest {
  url: string | undefined
  headers: http.IncomingHttpHeaders
}

const HOSTS: Record<string, string[] | undefined> = {
  'public.test': ['127.0.0.1'],
  'internal.test': ['10.0.0.5'],
  'mixed.test': ['127.0.0.1', '10.0.0.5'],
}

// テストサーバーのループバックだけを許可し、それ以外は本番と同じ判定にする
const allowLoopback = (address: string): boolean =>
  address === '127.0.0.1' ? false : isBlockedAddress(address)

const fakeLookup: net.LookupFunction = (hostname, options, callback) => {
  const addresses = HOSTS[hostname]
  if (!addresses) {
    callback(
      Object.assign(new Error(`ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
      }) as NodeJS.ErrnoException,
      '',
      0
    )
    return
  }
  const list = addresses.map((address) => ({
    address,
    family: net.isIP(address),
  }))
  if (options.all) {
    callback(null, list)
    return
  }
  callback(null, list[0].address, list[0].family)
}

const resolveTo =
  (addresses: string[]): net.LookupFunction =>
  (_hostname, options, callback) => {
    // 検証ラッパーは常に all: true で下位のリゾルバーを呼ぶ
    expect(options.all).toBe(true)
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: net.isIP(address),
      }))
    )
  }

describe('safe-fetch', () => {
  let server: http.Server
  let port: number
  let received: ReceivedRequest[]
  let handler: http.RequestListener

  const fetchText = (path: string, options = {}) =>
    safeFetchText(`http://public.test:${port}${path}`, {
      lookup: fakeLookup,
      isBlockedAddress: allowLoopback,
      ...options,
    })

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      received.push({ url: request.url, headers: request.headers })
      handler(request, response)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    port = (server.address() as net.AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })

  beforeEach(() => {
    received = []
    handler = (_request, response) => {
      response.writeHead(200)
      response.end('ok')
    }
  })

  describe('スキームと URL の検証', () => {
    it.each([
      ['file:///etc/passwd', 'file:'],
      ['ftp://example.com/feed.xml', 'ftp:'],
      ['gopher://example.com/', 'gopher:'],
    ])('%s を拒否する', async (url, scheme) => {
      await expect(safeFetchText(url)).rejects.toThrow(
        new UnsafeUrlError(`Unsupported URL scheme: ${scheme}`)
      )
      await expect(safeFetchText(url)).rejects.toBeInstanceOf(UnsafeUrlError)
    })

    it('URL として不正な文字列を拒否する', async () => {
      await expect(safeFetchText('not a url')).rejects.toThrow(
        new UnsafeUrlError('Invalid URL')
      )
    })

    it('ユーザー情報付きの URL を拒否する', async () => {
      await expect(
        safeFetchText('http://user:secret@example.com/')
      ).rejects.toThrow(new UnsafeUrlError('URL must not contain credentials'))
    })
  })

  describe('IP リテラルの検証', () => {
    it.each([
      ['http://127.0.0.1/', '127.0.0.1'],
      ['http://10.0.0.1/', '10.0.0.1'],
      ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
      ['http://192.168.0.1/', '192.168.0.1'],
      ['http://[::1]/', '::1'],
      ['http://[fd00::1]/', 'fd00::1'],
      ['http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
      ['http://[::ffff:7f00:1]/', '::ffff:7f00:1'],
      ['http://2130706433/', '127.0.0.1'],
      ['http://0x7f.1/', '127.0.0.1'],
      ['http://127.1/', '127.0.0.1'],
    ])('%s を拒否する', async (url, literal) => {
      await expect(safeFetchText(url)).rejects.toThrow(
        new UnsafeUrlError(`Blocked destination: ${literal}`)
      )
    })
  })

  describe('名前解決後の IP の検証', () => {
    it('禁止 IP に解決されるホスト名を拒否し、接続しない', async () => {
      await expect(
        safeFetchText(`http://internal.test:${port}/`, {
          lookup: fakeLookup,
          isBlockedAddress: allowLoopback,
        })
      ).rejects.toThrow(
        new UnsafeUrlError('Blocked destination: internal.test')
      )
      expect(received).toEqual([])
    })

    it('公開 IP と禁止 IP が混在して解決される場合も拒否する', async () => {
      await expect(
        safeFetchText(`http://mixed.test:${port}/`, {
          lookup: fakeLookup,
          isBlockedAddress: allowLoopback,
        })
      ).rejects.toThrow(new UnsafeUrlError('Blocked destination: mixed.test'))
      expect(received).toEqual([])
    })

    it('拒否した IP を message に含めず、address に保持する', async () => {
      const error = await safeFetchText(`http://internal.test:${port}/`, {
        lookup: fakeLookup,
        isBlockedAddress: allowLoopback,
      }).catch((error_: unknown) => error_)
      expect(error).toBeInstanceOf(UnsafeUrlError)
      expect((error as UnsafeUrlError).message).not.toContain('10.0.0.5')
      expect((error as UnsafeUrlError).address).toBe('10.0.0.5')
    })

    it('名前解決の失敗はそのまま伝える', async () => {
      await expect(
        safeFetchText(`http://unknown.test:${port}/`, {
          lookup: fakeLookup,
          isBlockedAddress: allowLoopback,
        })
      ).rejects.toThrow('ENOTFOUND unknown.test')
    })

    it('検証した IP でそのまま接続し、Host ヘッダーは元のホスト名にする', async () => {
      await expect(fetchText('/feed')).resolves.toBe('ok')
      expect(received).toHaveLength(1)
      expect(received[0].url).toBe('/feed')
      expect(received[0].headers.host).toBe(`public.test:${port}`)
    })
  })

  describe('リダイレクト', () => {
    it('禁止 IP リテラルへのリダイレクトを拒否する', async () => {
      handler = (_request, response) => {
        response.writeHead(302, {
          Location: 'http://169.254.169.254/latest/meta-data/',
        })
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new UnsafeUrlError('Blocked destination: 169.254.169.254')
      )
      expect(received).toHaveLength(1)
    })

    it('許可外のスキームへのリダイレクトを拒否する', async () => {
      handler = (_request, response) => {
        response.writeHead(301, { Location: 'file:///etc/passwd' })
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new UnsafeUrlError('Unsupported URL scheme: file:')
      )
    })

    it('禁止 IP に解決されるホスト名へのリダイレクトを拒否する', async () => {
      handler = (_request, response) => {
        response.writeHead(307, { Location: `http://internal.test:${port}/` })
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new UnsafeUrlError('Blocked destination: internal.test')
      )
      expect(received).toHaveLength(1)
    })

    it('スキーム相対の Location も現在の URL を基準に検証する', async () => {
      handler = (_request, response) => {
        response.writeHead(302, { Location: '//internal.test/secret' })
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new UnsafeUrlError('Blocked destination: internal.test')
      )
    })

    it('相対 Location を現在の URL を基準に解決して追従する', async () => {
      handler = (request, response) => {
        if (request.url === '/start') {
          response.writeHead(301, { Location: '/middle' })
          response.end()
        } else if (request.url === '/middle') {
          response.writeHead(308, {
            Location: `http://public.test:${port}/end`,
          })
          response.end()
        } else {
          response.writeHead(200)
          response.end('final')
        }
      }
      await expect(fetchText('/start')).resolves.toBe('final')
      expect(received.map((entry) => entry.url)).toEqual([
        '/start',
        '/middle',
        '/end',
      ])
    })

    it('Authorization と Cookie を全ホップで送らない', async () => {
      handler = (request, response) => {
        if (request.url === '/') {
          response.writeHead(302, { Location: '/next' })
          response.end()
        } else {
          response.writeHead(200)
          response.end('done')
        }
      }
      await fetchText('/')
      expect(received).toHaveLength(2)
      for (const entry of received) {
        expect(entry.headers.authorization).toBeUndefined()
        expect(entry.headers.cookie).toBeUndefined()
      }
    })

    it('リダイレクト回数が上限を超えたら RedirectError', async () => {
      handler = (_request, response) => {
        response.writeHead(302, { Location: '/loop' })
        response.end()
      }
      await expect(fetchText('/loop', { maxRedirects: 3 })).rejects.toThrow(
        new RedirectError(`Too many redirects: public.test:${port}`)
      )
      expect(received).toHaveLength(4)
    })

    it('Location がないリダイレクトは RedirectError', async () => {
      handler = (_request, response) => {
        response.writeHead(302)
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new RedirectError(`Redirect without Location: public.test:${port}`)
      )
    })
  })

  describe('タイムアウト', () => {
    it('応答がない場合は FetchTimeoutError', async () => {
      handler = () => {
        // 応答しない
      }
      await expect(fetchText('/', { timeoutMs: 200 })).rejects.toThrow(
        new FetchTimeoutError('Fetch timed out after 200ms')
      )
    })

    it('本文を少しずつ返し続ける場合も総期限で FetchTimeoutError', async () => {
      handler = (_request, response) => {
        response.writeHead(200)
        const interval = setInterval(() => {
          response.write('x')
        }, 20)
        response.on('close', () => {
          clearInterval(interval)
        })
      }
      await expect(fetchText('/', { timeoutMs: 200 })).rejects.toThrow(
        new FetchTimeoutError('Fetch timed out after 200ms')
      )
    })

    it('期限はリダイレクトを跨いで共有される', async () => {
      handler = (request, response) => {
        const timer = setTimeout(() => {
          if (request.url === '/') {
            response.writeHead(302, { Location: '/second' })
            response.end()
          } else {
            response.writeHead(200)
            response.end('late')
          }
        }, 120)
        response.on('close', () => {
          clearTimeout(timer)
        })
      }
      await expect(fetchText('/', { timeoutMs: 200 })).rejects.toThrow(
        new FetchTimeoutError('Fetch timed out after 200ms')
      )
      expect(received.map((entry) => entry.url)).toEqual(['/', '/second'])
    })
  })

  describe('応答サイズの上限', () => {
    it('Content-Length が上限を超えていれば拒否する', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Length': '10' })
        response.end('0123456789')
      }
      await expect(fetchText('/', { maxBytes: 5 })).rejects.toThrow(
        new ResponseTooLargeError(
          `Response exceeds 5 bytes: public.test:${port}`
        )
      )
    })

    it('Content-Length がなくても受信量が上限を超えれば拒否する', async () => {
      handler = (_request, response) => {
        response.writeHead(200)
        response.write('01234')
        response.end('56789')
      }
      await expect(fetchText('/', { maxBytes: 5 })).rejects.toBeInstanceOf(
        ResponseTooLargeError
      )
    })

    it('gzip の展開後が上限を超えれば拒否する', async () => {
      const compressed = zlib.gzipSync('a'.repeat(1000))
      expect(compressed.length).toBeLessThan(100)
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'gzip' })
        response.end(compressed)
      }
      await expect(fetchText('/', { maxBytes: 100 })).rejects.toBeInstanceOf(
        ResponseTooLargeError
      )
    })

    it('上限ちょうどの応答は受け付ける', async () => {
      handler = (_request, response) => {
        response.writeHead(200)
        response.end('12345')
      }
      await expect(fetchText('/', { maxBytes: 5 })).resolves.toBe('12345')
    })
  })

  describe('応答の処理', () => {
    it('2xx 以外は HttpStatusError にステータスを持たせる', async () => {
      handler = (_request, response) => {
        response.writeHead(404, 'Not Found')
        response.end('missing')
      }
      const error = await fetchText('/').catch((error_: unknown) => error_)
      expect(error).toEqual(new HttpStatusError(404, 'Not Found'))
      expect((error as HttpStatusError).status).toBe(404)
      expect((error as HttpStatusError).statusText).toBe('Not Found')
      expect((error as HttpStatusError).message).toBe(
        'Upstream responded with status 404'
      )
    })

    it('本文を UTF-8 として返す', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/rss+xml' })
        response.end('日本語のフィード')
      }
      await expect(fetchText('/')).resolves.toBe('日本語のフィード')
    })

    it.each([
      ['gzip', (text: string) => zlib.gzipSync(text)],
      ['x-gzip', (text: string) => zlib.gzipSync(text)],
      ['deflate', (text: string) => zlib.deflateSync(text)],
      ['br', (text: string) => zlib.brotliCompressSync(text)],
    ])('%s 圧縮された応答を展開して返す', async (encoding, compress) => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': encoding })
        response.end(compress('圧縮された本文'))
      }
      await expect(fetchText('/')).resolves.toBe('圧縮された本文')
    })

    it('未対応の Content-Encoding は SafeFetchError', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'compress' })
        response.end('x')
      }
      await expect(fetchText('/')).rejects.toThrow(
        new SafeFetchError('Unsupported content encoding: compress')
      )
    })

    it('破損した gzip は SafeFetchError ではないエラーで失敗する', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'gzip' })
        response.end('not gzip data')
      }
      const error = await fetchText('/').catch((error_: unknown) => error_)
      expect(error).toMatchObject({ code: 'Z_DATA_ERROR' })
      expect(error).not.toBeInstanceOf(SafeFetchError)
    })

    it('リクエストには Accept-Encoding と User-Agent だけを送る', async () => {
      await fetchText('/')
      expect(received[0].headers['accept-encoding']).toBe('gzip, deflate, br')
      expect(received[0].headers['user-agent']).toBe('rss-translator-bridge')
      expect(received[0].headers.cookie).toBeUndefined()
      expect(received[0].headers.authorization).toBeUndefined()
    })
  })

  describe('isBlockedAddress', () => {
    it.each([
      '0.0.0.1',
      '10.0.0.0',
      '10.255.255.255',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.0',
      '172.31.255.255',
      '192.0.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:8.8.8.8',
      '::ffff:0.0.0.0',
      '::ffff:7f00:1',
      '::ffff:0:8.8.8.8',
      '64:ff9b::808:808',
      '64:ff9b:1::1',
      '100::1',
      '2001::1',
      '2001:db8::1',
      '2002:7f00:1::',
      '3fff:fff::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      'fe80::1%eth0',
      'not-an-ip',
      '',
    ])('%s は禁止する', (address) => {
      expect(isBlockedAddress(address)).toBe(true)
    })

    it.each([
      '8.8.8.8',
      '1.1.1.1',
      '9.255.255.255',
      '11.0.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '192.169.0.1',
      '223.255.255.255',
      '2606:4700::1111',
      '2a00:1450:4001:81b::200e',
      '3fff:1000::',
    ])('%s は許可する', (address) => {
      expect(isBlockedAddress(address)).toBe(false)
    })
  })

  describe('createGuardedLookup', () => {
    it('all: true で呼ばれたら配列で返す', () => {
      const callback = jest.fn()
      createGuardedLookup(
        resolveTo(['93.184.216.34', '2606:2800:220:1::1']),
        isBlockedAddress
      )('example.test', { all: true }, callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ])
    })

    it('all が偽なら先頭 1 件を単一アドレス形式で返す', () => {
      const callback = jest.fn()
      createGuardedLookup(
        resolveTo(['93.184.216.34', '2606:2800:220:1::1']),
        isBlockedAddress
      )('example.test', {}, callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    })

    it.each([{ all: true }, {}])(
      '禁止 IP が 1 つでもあれば %j で呼ばれても拒否する',
      (options) => {
        const callback = jest.fn()
        createGuardedLookup(
          resolveTo(['93.184.216.34', '10.0.0.5']),
          isBlockedAddress
        )('mixed.test', options, callback)
        expect(callback).toHaveBeenCalledTimes(1)
        const [error] = callback.mock.calls[0] as [UnsafeUrlError]
        expect(error).toEqual(
          new UnsafeUrlError('Blocked destination: mixed.test')
        )
        expect(error).toBeInstanceOf(UnsafeUrlError)
        expect(error.address).toBe('10.0.0.5')
      }
    )

    it('下位のリゾルバーのエラーをそのまま伝える', () => {
      const failure = new Error('ENOTFOUND') as NodeJS.ErrnoException
      const callback = jest.fn()
      createGuardedLookup((_hostname, _options, done) => {
        done(failure, '', 0)
      }, isBlockedAddress)('missing.test', { all: true }, callback)
      expect(callback).toHaveBeenCalledWith(failure, '', 0)
    })
  })
})
