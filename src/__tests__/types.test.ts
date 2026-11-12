import {
  TranslateRequest,
  TranslateResponse,
  GASBatchTranslateRequest,
  GASBatchTranslateResponse,
  BatchTranslateItem,
  BatchTranslateResult,
  RSSItem,
  RSSFeed,
  RSSObject,
} from '../types'

describe('Type Definitions', () => {
  describe('TranslateRequest', () => {
    it('should validate correct TranslateRequest structure', () => {
      const validRequest: TranslateRequest = {
        url: 'https://example.com/feed.xml',
        sourceLang: 'en',
        targetLang: 'ja',
      }

      expect(validRequest.url).toBe('https://example.com/feed.xml')
      expect(validRequest.sourceLang).toBe('en')
      expect(validRequest.targetLang).toBe('ja')
    })

    it('should allow optional fields', () => {
      const minimalRequest: TranslateRequest = {
        url: 'https://example.com/feed.xml',
      }

      expect(minimalRequest.url).toBe('https://example.com/feed.xml')
      expect(minimalRequest.sourceLang).toBeUndefined()
      expect(minimalRequest.targetLang).toBeUndefined()
    })
  })

  describe('TranslateResponse', () => {
    it('should validate error response structure', () => {
      const errorResponse: TranslateResponse = {
        status: 'error',
        error: 'URL parameter is required',
      }

      expect(errorResponse.status).toBe('error')
      expect(errorResponse.error).toBe('URL parameter is required')
    })
  })

  describe('BatchTranslateItem', () => {
    it('should validate batch translate item structure', () => {
      const batchItem: BatchTranslateItem = {
        id: 'item-1',
        text: 'Hello world',
      }

      expect(batchItem.id).toBe('item-1')
      expect(batchItem.text).toBe('Hello world')
    })
  })

  describe('GASBatchTranslateRequest', () => {
    it('should validate batch translate request structure', () => {
      const batchRequest: GASBatchTranslateRequest = {
        batch: true,
        before: 'en',
        after: 'ja',
        texts: [
          { id: 'item-1', text: 'Hello' },
          { id: 'item-2', text: 'World' },
        ],
        mode: 'html',
      }

      expect(batchRequest.batch).toBe(true)
      expect(batchRequest.before).toBe('en')
      expect(batchRequest.after).toBe('ja')
      expect(batchRequest.texts).toHaveLength(2)
      expect(batchRequest.mode).toBe('html')
    })
  })

  describe('BatchTranslateResult', () => {
    it('should validate successful batch result structure', () => {
      const successResult: BatchTranslateResult = {
        id: 'item-1',
        success: true,
        original: 'Hello',
        translated: 'こんにちは',
      }

      expect(successResult.id).toBe('item-1')
      expect(successResult.success).toBe(true)
      expect(successResult.original).toBe('Hello')
      expect(successResult.translated).toBe('こんにちは')
      expect(successResult.error).toBeUndefined()
    })

    it('should validate failed batch result structure', () => {
      const failedResult: BatchTranslateResult = {
        id: 'item-1',
        success: false,
        original: 'Hello',
        error: 'Translation failed',
      }

      expect(failedResult.id).toBe('item-1')
      expect(failedResult.success).toBe(false)
      expect(failedResult.original).toBe('Hello')
      expect(failedResult.error).toBe('Translation failed')
      expect(failedResult.translated).toBeUndefined()
    })
  })

  describe('GASBatchTranslateResponse', () => {
    it('should validate batch translate response structure', () => {
      const batchResponse: GASBatchTranslateResponse = {
        status: true,
        processed: 2,
        total: 2,
        executionTime: 500,
        results: [
          {
            id: 'item-1',
            success: true,
            original: 'Hello',
            translated: 'こんにちは',
          },
          {
            id: 'item-2',
            success: false,
            original: 'World',
            error: 'Translation failed',
          },
        ],
      }

      expect(batchResponse.status).toBe(true)
      expect(batchResponse.processed).toBe(2)
      expect(batchResponse.total).toBe(2)
      expect(batchResponse.executionTime).toBe(500)
      expect(batchResponse.results).toHaveLength(2)
    })
  })

  describe('RSSItem', () => {
    it('should validate RSS item structure with all fields', () => {
      const rssItem: RSSItem = {
        title: 'Test Article',
        link: 'https://example.com/article',
        content: 'Article content',
        contentEncoded: '<p>Rich content</p>',
        summary: 'Article summary',
        pubDate: '2023-01-01T00:00:00Z',
        creator: 'John Doe',
        guid: 'article-1',
      }

      expect(rssItem.title).toBe('Test Article')
      expect(rssItem.link).toBe('https://example.com/article')
      expect(rssItem.content).toBe('Article content')
      expect(rssItem.contentEncoded).toBe('<p>Rich content</p>')
      expect(rssItem.summary).toBe('Article summary')
      expect(rssItem.pubDate).toBe('2023-01-01T00:00:00Z')
      expect(rssItem.creator).toBe('John Doe')
      expect(rssItem.guid).toBe('article-1')
    })

    it('should allow optional fields in RSS item', () => {
      const minimalRssItem: RSSItem = {}

      expect(minimalRssItem.title).toBeUndefined()
      expect(minimalRssItem.link).toBeUndefined()
      expect(minimalRssItem.content).toBeUndefined()
    })
  })

  describe('RSSFeed', () => {
    it('should validate RSS feed structure', () => {
      const rssFeed: RSSFeed = {
        title: 'Test Feed',
        description: 'Test Description',
        link: 'https://example.com',
        language: 'en',
        lastBuildDate: '2023-01-01T00:00:00Z',
        items: [
          {
            title: 'Item 1',
            link: 'https://example.com/item1',
          },
        ],
      }

      expect(rssFeed.title).toBe('Test Feed')
      expect(rssFeed.description).toBe('Test Description')
      expect(rssFeed.link).toBe('https://example.com')
      expect(rssFeed.language).toBe('en')
      expect(rssFeed.lastBuildDate).toBe('2023-01-01T00:00:00Z')
      expect(rssFeed.items).toHaveLength(1)
    })
  })

  describe('RSSObject', () => {
    it('should validate RSS XML object structure', () => {
      const rssObject: RSSObject = {
        rss: {
          $: {
            version: '2.0',
            'xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
            'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
          },
          channel: {
            title: 'Test Feed',
            link: 'https://example.com',
            description: 'Test Description',
            language: 'en',
            lastBuildDate: '2023-01-01T00:00:00Z',
            item: [
              {
                title: 'Test Item',
                link: 'https://example.com/item',
                description: 'Item description',
                pubDate: '2023-01-01T00:00:00Z',
                guid: 'item-1',
              },
            ],
          },
        },
      }

      expect(rssObject.rss.$.version).toBe('2.0')
      expect(rssObject.rss.$['xmlns:content']).toBe(
        'http://purl.org/rss/1.0/modules/content/'
      )
      expect(rssObject.rss.$['xmlns:dc']).toBe(
        'http://purl.org/dc/elements/1.1/'
      )
      expect(rssObject.rss.channel.title).toBe('Test Feed')
      expect(rssObject.rss.channel.item).toHaveLength(1)
    })

    it('should validate RSS XML object with content:encoded and dc:creator', () => {
      const rssObject: RSSObject = {
        rss: {
          $: {
            version: '2.0',
            'xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
            'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
          },
          channel: {
            title: 'Test Feed',
            link: 'https://example.com',
            description: 'Test Description',
            language: 'en',
            lastBuildDate: '2023-01-01T00:00:00Z',
            item: [
              {
                title: 'Test Item',
                link: 'https://example.com/item',
                description: 'Item description',
                pubDate: '2023-01-01T00:00:00Z',
                guid: 'item-1',
                'content:encoded': '<p>Rich content</p>',
                'dc:creator': 'John Doe',
              },
            ],
          },
        },
      }

      const item = rssObject.rss.channel.item[0]
      expect(item['content:encoded']).toBe('<p>Rich content</p>')
      expect(item['dc:creator']).toBe('John Doe')
    })
  })
})
