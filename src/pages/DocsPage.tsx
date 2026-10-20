import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, Copy, Hash, Info, Lightbulb, List, Search, Sparkles, TriangleAlert, X } from 'lucide-react'
import type { Page } from '../components/Sidebar'
import { bilingual as b, type DocsArticle, type DocsBlock, type DocsGroup } from '../docs/types'
import { articleSearchText, normalizeDocsSearch, searchArticles } from '../docs/search'
import { docsCatalog } from '../i18n/catalogs/docs'
import { useLocale, useTranslation } from '../i18n/useTranslation'
import '../styles/docs.css'

const labels = {
  brand: b('Lumina Docs', 'Lumina Docs'),
  eyebrow: b('THE CREATOR’S HANDBOOK', 'CẨM NANG NHÀ SÁNG TẠO'),
  quickstart: b('A good place to start', 'Bắt đầu từ đây'),
  browse: b('Browse guides', 'Khám phá hướng dẫn'),
  contents: b('On this page', 'Trong bài viết này'),
  clear: b('Clear search', 'Xóa tìm kiếm'),
  results: b('Matching guides', 'Hướng dẫn phù hợp'),
  noResults: b('No guides found. Try a feature name or a shorter phrase.', 'Không tìm thấy hướng dẫn. Hãy thử tên chức năng hoặc cụm từ ngắn hơn.'),
  empty: b('Your documentation is on its way.', 'Tài liệu hướng dẫn đang được chuẩn bị.'),
  open: b('Open in Lumina', 'Mở trong Lumina'),
  copy: b('Copy link', 'Sao chép liên kết'),
  copied: b('Link copied', 'Đã sao chép liên kết'),
  copyFailed: b('Could not copy automatically. Select and copy the link below.', 'Không thể tự động sao chép. Hãy chọn và sao chép liên kết bên dưới.'),
  permalink: b('Link to section', 'Liên kết đến mục'),
  related: b('Keep exploring', 'Khám phá thêm'),
  previous: b('Previous guide', 'Hướng dẫn trước'),
  next: b('Next guide', 'Hướng dẫn tiếp theo'),
  guide: b('Guide', 'Hướng dẫn'),
  skip: b('Skip to article', 'Chuyển đến bài viết'),
  top: b('Back to article top', 'Về đầu bài viết'),
}
const groups: Record<DocsGroup, ReturnType<typeof b>> = {
  start: b('Getting started', 'Bắt đầu sử dụng'),
  create: b('Create with Lumina', 'Sáng tạo với Lumina'),
  resources: b('Your creative resources', 'Tài nguyên sáng tạo'),
  advanced: b('Advanced workflows', 'Quy trình nâng cao'),
  manage: b('Account & management', 'Tài khoản & quản lý'),
  support: b('Help & troubleshooting', 'Trợ giúp & khắc phục lỗi'),
}
const groupOrder: DocsGroup[] = ['start', 'create', 'resources', 'advanced', 'manage', 'support']

export interface DocsPageProps {
  articles: DocsArticle[]
  articleId: string
  onSelectArticle: (id: string) => void
  onNavigate: (page: Page) => void
  role: 'admin' | 'user'
}

export function DocsPage({ articles, articleId, onSelectArticle, onNavigate, role }: DocsPageProps) {
  const { locale } = useLocale()
  const { t } = useTranslation(docsCatalog)
  const text = (key: keyof typeof labels) => labels[key][locale]
  const [query, setQuery] = useState('')
  const [activeSection, setActiveSection] = useState('')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [fallbackUrl, setFallbackUrl] = useState('')
  const articleRef = useRef<HTMLElement>(null)
  const previousArticle = useRef<string | undefined>(undefined)
  const mobileNav = useRef<HTMLDetailsElement>(null)
  const mobileToc = useRef<HTMLDetailsElement>(null)
  const visible = useMemo(() => articles.filter(item => role === 'admin' || item.audience !== 'admin'), [articles, role])
  const article = visible.find(item => item.id === articleId) ?? visible[0]
  const matches = useMemo(() => searchArticles(visible, query, locale), [visible, query, locale])
  const quickstarts = ['getting-started', 'quick-create', 'studio-projects'].map(id => visible.find(item => item.id === id)).filter((item): item is DocsArticle => Boolean(item))
  const featured = quickstarts.length ? quickstarts : visible.slice(0, 3)
  const currentIndex = article ? visible.indexOf(article) : -1
  const previous = visible[currentIndex - 1]
  const next = visible[currentIndex + 1]
  const destination = article?.destination
  const canNavigate = destination && (role === 'admin'
    ? ['account-settings', 'admin-accounts', 'admin-usage'].includes(destination)
    : !destination.startsWith('admin'))

  useEffect(() => {
    setCopyState('idle')
    setFallbackUrl('')
    const changed = previousArticle.current !== undefined && previousArticle.current !== article?.id
    previousArticle.current = article?.id
    const scrollToHash = () => {
      let hash = ''
      try { hash = decodeURIComponent(window.location.hash.slice(1)) } catch { /* A malformed fragment is not a section. */ }
      const section = article?.sections.find(item => item.id === hash)
      setActiveSection(section?.id ?? '')
      const target = section ? document.getElementById(section.id) : changed ? articleRef.current : null
      target?.scrollIntoView({ block: 'start' })
    }
    const frame = window.requestAnimationFrame(scrollToHash)
    window.addEventListener('hashchange', scrollToHash)
    window.addEventListener('popstate', scrollToHash)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('hashchange', scrollToHash)
      window.removeEventListener('popstate', scrollToHash)
    }
  }, [article?.id])

  function selectArticle(id: string) {
    mobileNav.current?.removeAttribute('open')
    mobileToc.current?.removeAttribute('open')
    onSelectArticle(id)
  }

  async function copyLink() {
    const url = new URL(window.location.href)
    url.searchParams.set('page', 'docs')
    if (article) url.searchParams.set('article', article.id)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(url.toString())
      setCopyState('copied')
    } catch {
      setFallbackUrl(url.toString())
      setCopyState('failed')
    }
  }

  function renderBlock(block: DocsBlock, index: number) {
    switch (block.type) {
      case 'paragraph': return <p key={index}>{block.text[locale]}</p>
      case 'steps': return <ol key={index} className="docs-steps">{block.items.map((item, i) => <li key={i}><span>{item[locale]}</span></li>)}</ol>
      case 'list': return <ul key={index} className="docs-list">{block.items.map((item, i) => <li key={i}>{item[locale]}</li>)}</ul>
      case 'callout': {
        const Icon = block.tone === 'warning' ? TriangleAlert : block.tone === 'tip' ? Lightbulb : Info
        return <aside key={index} className={`docs-callout docs-callout--${block.tone}`}><Icon size={20} aria-hidden="true" /><div><strong>{block.title[locale]}</strong><p>{block.text[locale]}</p></div></aside>
      }
      case 'table': return <div key={index} className="docs-table-wrap" tabIndex={0} role="region" aria-label={article?.title[locale]}><table className="docs-table"><thead><tr>{block.headers.map((header, i) => <th scope="col" key={i}>{header[locale]}</th>)}</tr></thead><tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell[locale]}</td>)}</tr>)}</tbody></table></div>
      case 'example': return <div key={index} className="docs-example"><div className="docs-example-title"><Sparkles size={16} aria-hidden="true" /><strong>{block.title[locale]}</strong></div><p>{block.text[locale]}</p></div>
    }
  }

  function searchExcerpt(item: DocsArticle): string {
    const body = articleSearchText(item, locale)
    const term = normalizeDocsSearch(query).split(' ').find(Boolean) ?? ''
    const position = normalizeDocsSearch(body).indexOf(term)
    const start = Math.max(0, position - 35)
    return `${start ? '…' : ''}${body.slice(start, start + 180)}${body.length > start + 180 ? '…' : ''}`
  }
  function articleButton(item: DocsArticle) {
    return <button type="button" key={item.id} aria-label={item.title[locale]} className={`docs-nav-item${article?.id === item.id ? ' docs-nav-item--active' : ''}`} aria-current={article?.id === item.id ? 'page' : undefined} onClick={() => selectArticle(item.id)}><span>{item.title[locale]}{query.trim() && <small className="docs-search-excerpt">{searchExcerpt(item)}</small>}</span>{article?.id === item.id && <span className="docs-nav-dot" aria-hidden="true" />}</button>
  }
  function navigation() {
    return <nav aria-label={text('browse')} className="docs-navigation">{query.trim() ? <div className="docs-nav-group"><h3>{text('results')} <span>{matches.length}</span></h3>{matches.map(articleButton)}{!matches.length && <p className="docs-no-results" role="status">{text('noResults')}</p>}</div> : groupOrder.map(group => {
      const items = visible.filter(item => item.group === group)
      return items.length ? <div className="docs-nav-group" key={group}><h3>{groups[group][locale]}</h3>{items.map(articleButton)}</div> : null
    })}</nav>
  }
  function toc() {
    return <nav aria-label={text('contents')} className="docs-toc-links">{article?.sections.map((section, index) => <a key={section.id} href={`#${encodeURIComponent(section.id)}`} className={activeSection === section.id ? 'docs-toc-active' : undefined} aria-current={activeSection === section.id ? 'location' : undefined} onClick={() => { setActiveSection(section.id); mobileToc.current?.removeAttribute('open') }}><span className="docs-toc-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{section.title[locale]}</a>)}</nav>
  }

  return <div className="docs-page">
    <a className="docs-skip" href="#docs-article">{text('skip')}</a>
    <header className="docs-hero">
      <div className="docs-hero-copy"><div className="docs-eyebrow"><BookOpen size={15} aria-hidden="true" />{text('eyebrow')}</div><h1>{t('title')}</h1><p>{t('description')}</p></div>
      <div className="docs-hero-mark" aria-hidden="true"><BookOpen strokeWidth={1} /><Sparkles /></div>
    </header>
    <section className="docs-quickstart" aria-label={text('quickstart')}>
      {featured.map((item, index) => <button type="button" key={item.id} className="docs-quick-card" onClick={() => selectArticle(item.id)}><span className="docs-card-top"><span className="docs-card-index">{String(index + 1).padStart(2, '0')}</span><ArrowUpRight size={18} aria-hidden="true" /></span><strong>{item.title[locale]}</strong><span className="docs-card-description">{item.description[locale]}</span></button>)}
    </section>
    <div className="docs-toolbar"><div className="docs-wordmark"><BookOpen size={19} aria-hidden="true" />{text('brand')}</div><div className="docs-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label={t('search')} placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label={text('clear')} onClick={() => setQuery('')}><X size={16} aria-hidden="true" /></button>}</div></div>
    <div className="docs-mobile-controls"><details ref={mobileNav} className="docs-mobile-nav"><summary><BookOpen size={17} aria-hidden="true" />{text('browse')}<ChevronDown size={16} aria-hidden="true" /></summary>{navigation()}</details>{article && <details ref={mobileToc} className="docs-mobile-toc"><summary><List size={17} aria-hidden="true" />{text('contents')}<ChevronDown size={16} aria-hidden="true" /></summary>{toc()}</details>}</div>
    <div className="docs-layout">
      <aside className="docs-sidebar">{navigation()}</aside>
      <article id="docs-article" className="docs-article" ref={articleRef} tabIndex={-1}>
        {article ? <><header className="docs-article-header"><div className="docs-article-meta"><span>{groups[article.group][locale]}</span><span aria-hidden="true">/</span><span>{text('guide')}</span></div><h2>{article.title[locale]}</h2><p className="docs-lead">{article.description[locale]}</p><div className="docs-article-actions">{canNavigate && destination && <button type="button" className="primary-small-button docs-action" onClick={() => onNavigate(destination)}>{text('open')}<ArrowUpRight size={16} aria-hidden="true" /></button>}<button type="button" className="secondary-button docs-action" onClick={() => void copyLink()}>{copyState === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copyState === 'copied' ? text('copied') : text('copy')}</button></div><div className="docs-copy-status" role="status">{copyState === 'copied' && text('copied')}{copyState === 'failed' && <><p>{text('copyFailed')}</p><input aria-label={text('copy')} readOnly value={fallbackUrl} onFocus={event => event.currentTarget.select()} /></>}</div></header>
          {article.sections.map((section, index) => <section className="docs-section" id={section.id} key={section.id}><h3><span className="docs-section-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{section.title[locale]}<a className="docs-anchor" href={`#${encodeURIComponent(section.id)}`} aria-label={`${text('permalink')}: ${section.title[locale]}`}><Hash size={17} aria-hidden="true" /></a></h3>{section.blocks.map(renderBlock)}</section>)}
          {article.related.some(id => visible.some(item => item.id === id)) && <section className="docs-related"><h3>{text('related')}</h3><div>{article.related.map(id => visible.find(item => item.id === id)).filter((item): item is DocsArticle => Boolean(item) && item?.id !== article.id).map(item => <button key={item.id} type="button" onClick={() => selectArticle(item.id)}><BookOpen size={17} aria-hidden="true" /><span>{item.title[locale]}</span><ArrowUpRight size={16} aria-hidden="true" /></button>)}</div></section>}
          <footer className="docs-pagination">{previous ? <button type="button" onClick={() => selectArticle(previous.id)}><ArrowLeft size={18} aria-hidden="true" /><span><small>{text('previous')}</small><strong>{previous.title[locale]}</strong></span></button> : <span />}{next && <button type="button" onClick={() => selectArticle(next.id)}><span><small>{text('next')}</small><strong>{next.title[locale]}</strong></span><ArrowRight size={18} aria-hidden="true" /></button>}</footer>
        </> : <div className="docs-empty"><BookOpen size={32} aria-hidden="true" /><p>{text('empty')}</p></div>}
      </article>
      {article && <aside className="docs-toc"><h2><List size={16} aria-hidden="true" />{text('contents')}</h2>{toc()}<a className="docs-back-top" href="#docs-article">{text('top')}<ArrowUpRight size={14} aria-hidden="true" /></a></aside>}
    </div>
  </div>
}
