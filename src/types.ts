/** アプリケーション設定。 */
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

/** 翻訳キャッシュ設定。 */
export interface TranslationCacheConfig {
  enabled: boolean
  ttlMs: number
  maxItems: number
}

/** CDN キャッシュ設定。 */
export interface CacheControlConfig {
  enabled: boolean
  sMaxAge: number
  staleWhileRevalidate: number
}

/** 翻訳 API のリクエストパラメータ。 */
export interface TranslateRequest {
  url: string
  sourceLang?: string
  targetLang?: string
  excludeFeedTitle?: string
  excludeItemTitle?: string
}

/** 翻訳 API のレスポンス。 */
export interface TranslateResponse {
  status: 'success' | 'error'
  data?: string
  error?: string
}

/** GAS 翻訳リクエスト。 */
export interface GASTranslateRequest {
  before: string
  after: string
  text: string
  mode: 'html'
}

/** GAS 翻訳レスポンス。 */
export interface GASTranslateResponse {
  text: string
}

/** バッチ翻訳の入力項目。 */
export interface BatchTranslateItem {
  id: string
  text: string
}

/** GAS バッチ翻訳リクエスト。 */
export interface GASBatchTranslateRequest {
  batch: true
  before: string
  after: string
  texts: BatchTranslateItem[]
  mode: 'html'
}

/** バッチ翻訳の結果。 */
export interface BatchTranslateResult {
  id: string
  original: string
  translated?: string
  success: boolean
  error?: string
}

/** GAS バッチ翻訳レスポンス。 */
export interface GASBatchTranslateResponse {
  status: boolean
  results: BatchTranslateResult[]
  processed: number
  total: number
  executionTime: number
}

/** RSS アイテム。 */
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

/** RSS フィード。 */
export interface RSSFeed {
  title?: string
  link?: string
  description?: string
  language?: string
  lastBuildDate?: string
  items?: RSSItem[]
  [key: string]: unknown
}

/** RSS XML 生成用のオブジェクト。 */
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
