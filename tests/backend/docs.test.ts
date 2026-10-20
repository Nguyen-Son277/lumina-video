import { describe, expect, it } from 'vitest'
import { docsArticles } from '../../src/docs/content/index'
import { searchArticles } from '../../src/docs/search'
import { bilingual as b, type DocsArticle, type DocsBlock, type DocsText } from '../../src/docs/types'

const articleIds = [
  'getting-started', 'api-models', 'quick-create', 'studio-projects', 'scenes-export',
  'characters', 'identity-library', 'script-planner', 'timeline', 'canvas',
  'results-library', 'usage', 'trash', 'account-settings', 'admin',
  'video-providers', 'troubleshooting', 'privacy-costs',
]
const groups = ['start', 'create', 'resources', 'advanced', 'manage', 'support']
const destinations = [
  'quick', 'studio', 'characters', 'entities', 'library', 'planner', 'timeline',
  'usage', 'trash', 'settings', 'account-settings', 'admin-accounts', 'admin-usage',
]

function expectBilingual(text: DocsText): void {
  expect(text).toEqual({ en: expect.any(String), vi: expect.any(String) })
  for (const locale of ['en', 'vi'] as const) expect(text[locale].trim().length).toBeGreaterThan(0)
}

function expectBlock(block: DocsBlock): void {
  switch (block.type) {
    case 'paragraph':
      expectBilingual(block.text)
      break
    case 'steps':
    case 'list':
      expect(block.items.length).toBeGreaterThan(0)
      block.items.forEach(expectBilingual)
      break
    case 'callout':
      expect(['tip', 'warning', 'info']).toContain(block.tone)
      expectBilingual(block.title)
      expectBilingual(block.text)
      break
    case 'example':
      expectBilingual(block.title)
      expectBilingual(block.text)
      break
    case 'table':
      expect(block.headers.length).toBeGreaterThan(0)
      expect(block.rows.length).toBeGreaterThan(0)
      block.headers.forEach(expectBilingual)
      for (const row of block.rows) {
        expect(row).toHaveLength(block.headers.length)
        row.forEach(expectBilingual)
      }
      break
    default:
      throw new Error(`Unknown docs block: ${JSON.stringify(block)}`)
  }
}

function fixture(id: string, title: DocsText, keywords: DocsText, blocks: DocsBlock[]): DocsArticle {
  return {
    id, group: 'support', title, keywords,
    description: b('Search fixture description', 'Mô tả dữ liệu kiểm thử tìm kiếm'),
    sections: [{ id: 'section', title: b('Section', 'Phần'), blocks }], related: [],
  }
}

describe('Docs content contract', () => {
  it('publishes every agreed article exactly once', () => {
    expect(docsArticles.map(article => article.id).sort()).toEqual([...articleIds].sort())
    expect(new Set(docsArticles.map(article => article.id)).size).toBe(docsArticles.length)
  })

  for (const article of docsArticles) {
    it(`${article.id} has complete bilingual content and valid navigation`, () => {
      expect(article.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(groups).toContain(article.group)
      expectBilingual(article.title)
      expectBilingual(article.description)
      expectBilingual(article.keywords)
      if (article.destination !== undefined) expect(destinations).toContain(article.destination)
      if (article.audience !== undefined) expect(['user', 'admin']).toContain(article.audience)
      expect(article.sections.length).toBeGreaterThanOrEqual(['account-settings', 'admin'].includes(article.id) ? 3 : 4)
      expect(new Set(article.sections.map(section => section.id)).size).toBe(article.sections.length)
      for (const section of article.sections) {
        expect(section.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        expectBilingual(section.title)
        expect(section.blocks.length).toBeGreaterThan(0)
        section.blocks.forEach(expectBlock)
      }
      expect(new Set(article.related).size).toBe(article.related.length)
      for (const related of article.related) {
        expect(articleIds).toContain(related)
        expect(related).not.toBe(article.id)
      }
    })
  }
})

describe('Docs local search', () => {
  it('finds Vietnamese password guidance without accents or case sensitivity', () => {
    const results = searchArticles(docsArticles, 'mat khau', 'vi')
    expect(results.map(article => article.id)).toContain('account-settings')
    expect(searchArticles(docsArticles, '  MẬT KHẨU  ', 'vi')).toEqual(results)
  })

  it('returns no articles for an unknown query and all articles for an empty query', () => {
    expect(searchArticles(docsArticles, 'unfindable_zqxv_987654321', 'en')).toEqual([])
    expect(searchArticles(docsArticles, 'unfindable_zqxv_987654321', 'vi')).toEqual([])
    expect(searchArticles(docsArticles, '   ', 'en')).toEqual(docsArticles)
  })

  it('searches nested blocks in the selected locale and requires every query term', () => {
    const article = fixture('nested', b('Guide', 'Hướng dẫn'), b('setup', 'thiết lập'), [
      { type: 'table', headers: [b('Field', 'Trường')], rows: [[b('secret table phrase', 'Đổi mật khẩu')]] },
      { type: 'callout', tone: 'warning', title: b('Caution', 'Chú ý'), text: b('Keep credentials safe', 'Bảo vệ thông tin đăng nhập') },
    ])
    expect(searchArticles([article], 'doi mat khau', 'vi')).toEqual([article])
    expect(searchArticles([article], 'secret phrase', 'en')).toEqual([article])
    expect(searchArticles([article], 'secret phrase missing', 'en')).toEqual([])
    expect(searchArticles([article], 'secret phrase', 'vi')).toEqual([])
    expect(searchArticles([article], 'bao ve', 'vi')).toEqual([article])
  })

  it('ranks title before keywords before body, preserves ties, and does not mutate input', () => {
    const body = fixture('body', b('Guide', 'Hướng dẫn'), b('setup', 'thiết lập'), [{ type: 'paragraph', text: b('password', 'mật khẩu') }])
    const keyword = fixture('keyword', b('Guide', 'Hướng dẫn'), b('password', 'mật khẩu'), [])
    const title = fixture('title', b('Password', 'Mật khẩu'), b('setup', 'thiết lập'), [])
    const tie = { ...title, id: 'tie' }
    const articles = [body, keyword, title, tie]
    const original = JSON.stringify(articles)
    expect(searchArticles(articles, 'password', 'en').map(article => article.id)).toEqual(['title', 'tie', 'keyword', 'body'])
    expect(JSON.stringify(articles)).toBe(original)
  })
})
