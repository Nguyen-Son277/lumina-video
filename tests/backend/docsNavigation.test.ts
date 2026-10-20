import { describe, expect, it } from 'vitest'
import { DOCS_ARTICLE_IDS, resolveDocsArticle } from '../../src/docs/navigation'
import { normalizeDocsSearch, searchArticles } from '../../src/docs/search'
import { bilingual as b, type DocsArticle } from '../../src/docs/types'

const article = (id: string, title: string, body: string): DocsArticle => ({
  id, group: 'start', title: b(title, title), description: b('Guide', 'Hướng dẫn'), keywords: b('setup', 'thiết lập'), related: [],
  sections: [{ id: 'steps', title: b('Steps', 'Các bước'), blocks: [{ type: 'paragraph', text: b(body, body) }] }],
})

describe('Docs URL and search utilities', () => {
  it('resolves invalid URLs and restricts the admin article for users', () => {
    expect(resolveDocsArticle(null)).toBe('getting-started')
    expect(resolveDocsArticle('<script>')).toBe('getting-started')
    expect(resolveDocsArticle('admin', 'user')).toBe('getting-started')
    expect(resolveDocsArticle('admin', 'admin')).toBe('admin')
    expect(new Set(DOCS_ARTICLE_IDS).size).toBe(DOCS_ARTICLE_IDS.length)
    for (const id of DOCS_ARTICLE_IDS) expect(resolveDocsArticle(id, 'admin')).toBe(id)
  })
  it('normalizes Vietnamese accents, case and punctuation', () => {
    expect(normalizeDocsSearch('  ĐỔI Mật-khẩu! ')).toBe('doi mat khau')
    expect(normalizeDocsSearch('ĐỒ VẬT #logo @An')).toBe('do vat #logo @an')
  })
  it('requires all query terms and ranks titles before body text', () => {
    const articles = [article('body', 'Other', 'Đổi mật khẩu'), article('title', 'Đổi mật khẩu', 'Account settings')]
    expect(searchArticles(articles, 'mat KHAU', 'vi').map(item => item.id)).toEqual(['title', 'body'])
    expect(searchArticles(articles, 'mat khau missing', 'vi')).toEqual([])
    expect(searchArticles(articles, '  ', 'en')).toEqual(articles)
  })
})
