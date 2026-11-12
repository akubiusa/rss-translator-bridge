/** Application config built by `loadConfig`. */
export interface Config {
  gasUrl: string
  port?: number
  host?: string
  defaultSourceLang?: string
  defaultTargetLang?: string
  defaultExcludeFeedTitle?: boolean
  defaultExcludeItemTitle?: boolean
  translationCache: TranslationCacheConfig
  cacheControl: CacheControlConfig
}

/** Translation cache settings. */
export interface TranslationCacheConfig {
  enabled: boolean
  ttlMs: number
  maxItems: number
}

/** CDN `Cache-Control` settings. */
export interface CacheControlConfig {
  enabled: boolean
  sMaxAge: number
  staleWhileRevalidate: number
}

/** Query parameters of `GET /api`. The exclude flags are the strings `"true"` or `"false"`. */
export interface TranslateRequest {
  url: string
  sourceLang?: string
  targetLang?: string
  excludeFeedTitle?: string
  excludeItemTitle?: string
}

/** JSON body of `GET /api` responses. Only error bodies are returned today; success responses are RSS XML. */
export interface TranslateResponse {
  status: 'success' | 'error'
  data?: string
  error?: string
}

/** An item to translate in a batch. */
export interface BatchTranslateItem {
  id: string
  text: string
}

/** Request body for batch translation with the GAS API. */
export interface GASBatchTranslateRequest {
  batch: true
  before: string
  after: string
  texts: BatchTranslateItem[]
  mode: 'html'
}

/** Per-item result of a batch translation. */
export interface BatchTranslateResult {
  id: string
  original: string
  translated?: string
  success: boolean
  error?: string
}

/** Response of the GAS API for a batch. */
export interface GASBatchTranslateResponse {
  status: boolean
  results: BatchTranslateResult[]
  processed: number
  total: number
  executionTime: number
}

/** An item of a parsed RSS feed. */
export interface RSSItem {
  title?: string
  link?: string
  description?: string
  content?: string
  summary?: string
  contentEncoded?: string
  pubDate?: string
  guid?: string
  creator?: string
  [key: string]: unknown
}

/** A parsed RSS feed. */
export interface RSSFeed {
  title?: string
  link?: string
  description?: string
  language?: string
  lastBuildDate?: string
  items?: RSSItem[]
  [key: string]: unknown
}

/** Object passed to the xml2js builder to generate RSS XML. */
export interface RSSObject {
  rss: {
    $: {
      version: string
      'xmlns:content': string
      'xmlns:dc': string
    }
    channel: {
      title: string
      link: string
      description: string
      language: string
      lastBuildDate: string
      item: {
        title: string
        link: string
        description: string
        pubDate: string
        guid: string
        'content:encoded'?: string
        'dc:creator'?: string
      }[]
    }
  }
}
