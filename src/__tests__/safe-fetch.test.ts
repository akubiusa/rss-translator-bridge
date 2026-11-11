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

// Allow only the test server's loopback address; everything else uses the production check
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
    // The validating wrapper always calls the underlying resolver with all: true
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

  describe('scheme and URL validation', () => {
    it.each([
      ['file:///etc/passwd', 'file:'],
      ['ftp://example.com/feed.xml', 'ftp:'],
      ['gopher://example.com/', 'gopher:'],
    ])('rejects %s', async (url, scheme) => {
      await expect(safeFetchText(url)).rejects.toThrow(
        new UnsafeUrlError(`Unsupported URL scheme: ${scheme}`)
      )
      await expect(safeFetchText(url)).rejects.toBeInstanceOf(UnsafeUrlError)
    })

    it('rejects a string that is not a valid URL', async () => {
      await expect(safeFetchText('not a url')).rejects.toThrow(
        new UnsafeUrlError('Invalid URL')
      )
    })

    it('rejects a URL with credentials', async () => {
      await expect(
        safeFetchText('http://user:secret@example.com/')
      ).rejects.toThrow(new UnsafeUrlError('URL must not contain credentials'))
    })
  })

  describe('IP literal validation', () => {
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
    ])('rejects %s', async (url, literal) => {
      await expect(safeFetchText(url)).rejects.toThrow(
        new UnsafeUrlError(`Blocked destination: ${literal}`)
      )
    })
  })

  describe('validation of resolved IPs', () => {
    it('rejects a hostname resolving to a blocked IP without connecting', async () => {
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

    it('rejects a hostname resolving to both public and blocked IPs', async () => {
      await expect(
        safeFetchText(`http://mixed.test:${port}/`, {
          lookup: fakeLookup,
          isBlockedAddress: allowLoopback,
        })
      ).rejects.toThrow(new UnsafeUrlError('Blocked destination: mixed.test'))
      expect(received).toEqual([])
    })

    it('keeps the rejected IP in address, not in message', async () => {
      const error = await safeFetchText(`http://internal.test:${port}/`, {
        lookup: fakeLookup,
        isBlockedAddress: allowLoopback,
      }).catch((error_: unknown) => error_)
      expect(error).toBeInstanceOf(UnsafeUrlError)
      expect((error as UnsafeUrlError).message).not.toContain('10.0.0.5')
      expect((error as UnsafeUrlError).address).toBe('10.0.0.5')
    })

    it('propagates resolution failures as they are', async () => {
      await expect(
        safeFetchText(`http://unknown.test:${port}/`, {
          lookup: fakeLookup,
          isBlockedAddress: allowLoopback,
        })
      ).rejects.toThrow('ENOTFOUND unknown.test')
    })

    it('connects to the validated IP and keeps the original hostname in the Host header', async () => {
      await expect(fetchText('/feed')).resolves.toBe('ok')
      expect(received).toHaveLength(1)
      expect(received[0].url).toBe('/feed')
      expect(received[0].headers.host).toBe(`public.test:${port}`)
    })
  })

  describe('redirects', () => {
    it('rejects a redirect to a blocked IP literal', async () => {
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

    it('rejects a redirect to a disallowed scheme', async () => {
      handler = (_request, response) => {
        response.writeHead(301, { Location: 'file:///etc/passwd' })
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new UnsafeUrlError('Unsupported URL scheme: file:')
      )
    })

    it('rejects a redirect to a hostname resolving to a blocked IP', async () => {
      handler = (_request, response) => {
        response.writeHead(307, { Location: `http://internal.test:${port}/` })
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new UnsafeUrlError('Blocked destination: internal.test')
      )
      expect(received).toHaveLength(1)
    })

    it('validates a scheme-relative Location against the current URL', async () => {
      handler = (_request, response) => {
        response.writeHead(302, { Location: '//internal.test/secret' })
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new UnsafeUrlError('Blocked destination: internal.test')
      )
    })

    it('resolves a relative Location against the current URL and follows it', async () => {
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

    it('sends no Authorization or Cookie on any hop', async () => {
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

    it('throws RedirectError when the redirect limit is exceeded', async () => {
      handler = (_request, response) => {
        response.writeHead(302, { Location: '/loop' })
        response.end()
      }
      await expect(fetchText('/loop', { maxRedirects: 3 })).rejects.toThrow(
        new RedirectError(`Too many redirects: public.test:${port}`)
      )
      expect(received).toHaveLength(4)
    })

    it('throws RedirectError for a redirect without Location', async () => {
      handler = (_request, response) => {
        response.writeHead(302)
        response.end()
      }
      await expect(fetchText('/')).rejects.toThrow(
        new RedirectError(`Redirect without Location: public.test:${port}`)
      )
    })
  })

  describe('timeouts', () => {
    it('throws FetchTimeoutError when there is no response', async () => {
      handler = () => {
        // Never respond
      }
      await expect(fetchText('/', { timeoutMs: 200 })).rejects.toThrow(
        new FetchTimeoutError('Fetch timed out after 200ms')
      )
    })

    it('throws FetchTimeoutError at the total deadline even if the body trickles in', async () => {
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

    it('shares the deadline across redirects', async () => {
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

  describe('response size limit', () => {
    it('rejects when Content-Length exceeds the limit', async () => {
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

    it('rejects when the received size exceeds the limit without Content-Length', async () => {
      handler = (_request, response) => {
        response.writeHead(200)
        response.write('01234')
        response.end('56789')
      }
      await expect(fetchText('/', { maxBytes: 5 })).rejects.toBeInstanceOf(
        ResponseTooLargeError
      )
    })

    it('rejects when the gunzipped size exceeds the limit', async () => {
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

    it('accepts a response exactly at the limit', async () => {
      handler = (_request, response) => {
        response.writeHead(200)
        response.end('12345')
      }
      await expect(fetchText('/', { maxBytes: 5 })).resolves.toBe('12345')
    })
  })

  describe('response handling', () => {
    it('throws HttpStatusError carrying the status for non-2xx responses', async () => {
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

    it('returns the body as UTF-8', async () => {
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
    ])('decompresses a %s response', async (encoding, compress) => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': encoding })
        response.end(compress('圧縮された本文'))
      }
      await expect(fetchText('/')).resolves.toBe('圧縮された本文')
    })

    it('decodes the body using the Content-Type charset', async () => {
      handler = (_request, response) => {
        response.writeHead(200, {
          'Content-Type': 'application/rss+xml; charset=ISO-8859-1',
        })
        response.end(Buffer.from('Café München', 'latin1'))
      }
      await expect(fetchText('/')).resolves.toBe('Café München')
    })

    it('treats an unsupported charset as UTF-8', async () => {
      handler = (_request, response) => {
        response.writeHead(200, {
          'Content-Type': 'application/rss+xml; charset=no-such-charset',
        })
        response.end('日本語')
      }
      await expect(fetchText('/')).resolves.toBe('日本語')
    })

    it('returns an empty string for a bodiless response with Content-Encoding', async () => {
      handler = (_request, response) => {
        response.writeHead(200, {
          'Content-Encoding': 'gzip',
          'Content-Length': '0',
        })
        response.end()
      }
      await expect(fetchText('/')).resolves.toBe('')
    })

    it('throws SafeFetchError for an unsupported Content-Encoding', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'compress' })
        response.end('x')
      }
      await expect(fetchText('/')).rejects.toThrow(
        new SafeFetchError('Unsupported content encoding: compress')
      )
    })

    it('fails a corrupt gzip with an error other than SafeFetchError', async () => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'gzip' })
        response.end('not gzip data')
      }
      const error = await fetchText('/').catch((error_: unknown) => error_)
      expect(error).toMatchObject({ code: 'Z_DATA_ERROR' })
      expect(error).not.toBeInstanceOf(SafeFetchError)
    })

    it('sends only Accept-Encoding and User-Agent', async () => {
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
      'fec0::1',
      'ff02::1',
      'fe80::1%eth0',
      'not-an-ip',
      '',
    ])('blocks %s', (address) => {
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
    ])('allows %s', (address) => {
      expect(isBlockedAddress(address)).toBe(false)
    })
  })

  describe('createGuardedLookup', () => {
    it('returns an array when called with all: true', () => {
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

    it('returns the first address in single-address form when all is falsy', () => {
      const callback = jest.fn()
      createGuardedLookup(
        resolveTo(['93.184.216.34', '2606:2800:220:1::1']),
        isBlockedAddress
      )('example.test', {}, callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    })

    it.each([{ all: true }, {}])(
      'rejects when any IP is blocked, even when called with %j',
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

    it('propagates errors of the underlying resolver as they are', () => {
      const failure = new Error('ENOTFOUND') as NodeJS.ErrnoException
      const callback = jest.fn()
      createGuardedLookup((_hostname, _options, done) => {
        done(failure, '', 0)
      }, isBlockedAddress)('missing.test', { all: true }, callback)
      expect(callback).toHaveBeenCalledWith(failure, '', 0)
    })
  })
})
