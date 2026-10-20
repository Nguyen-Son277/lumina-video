import type { Locale } from '../i18n/types'
import type { DocsArticle, DocsText } from './types'

export function normalizeDocsSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9@#]+/g, ' ').trim()
}

export function articleSearchText(article: DocsArticle, locale: Locale): string {
  const texts: string[] = []
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return
    if ('en' in value && 'vi' in value) { texts.push((value as DocsText)[locale]); return }
    for (const entry of Object.values(value)) {
      if (Array.isArray(entry)) entry.forEach(collect)
      else collect(entry)
    }
  }
  collect(article)
  return texts.join(' ')
}

/** Search is local, accent-insensitive and ranked by title, then keywords. */
export function searchArticles(articles: DocsArticle[], query: string, locale: Locale): DocsArticle[] {
  const terms = normalizeDocsSearch(query).split(' ').filter(Boolean)
  if (!terms.length) return articles
  return articles.map((article, index) => {
    const title = normalizeDocsSearch(article.title[locale])
    const keywords = normalizeDocsSearch(article.keywords[locale])
    const text = normalizeDocsSearch(articleSearchText(article, locale))
    const score = terms.every(term => text.includes(term))
      ? terms.reduce((sum, term) => sum + (title.includes(term) ? 10 : keywords.includes(term) ? 4 : 1), 0) : 0
    return { article, index, score }
  }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map(result => result.article)
}
