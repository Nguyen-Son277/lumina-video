import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  GalleryHorizontalEnd,
  KeyRound,
  Layers3,
  LayoutGrid,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Trash2,
  Users,
  WandSparkles,
  Zap,
} from 'lucide-react'
import type { User } from '../api/types'
import { LanguageSwitcher, useTranslation } from '../i18n'
import { shellCatalog, type ShellCatalogKey } from '../i18n/catalogs/shell'
import { notification, type Notification } from '../i18n/messages'

export type Page = 'quick' | 'studio' | 'characters' | 'library' | 'planner' | 'timeline' | 'settings'

/** Khoá catalog cho nhãn từng trang (payload URL không đổi). */
const PAGE_LABEL_KEYS: Record<Page, ShellCatalogKey> = {
  quick: 'navQuick',
  studio: 'navStudio',
  characters: 'navCharacters',
  library: 'navLibrary',
  planner: 'navPlanner',
  timeline: 'navTimeline',
  settings: 'navApiModels',
}

export function NavItem({ icon, label, active, count, onClick }: {
  icon: ReactNode
  label: string
  active?: boolean
  count?: number
  onClick: () => void
}) {
  return (
    // `title` + `aria-label` để mục vẫn đọc và bấm được khi sidebar thu gọn chỉ còn icon.
    <button
      className={`nav-item ${active ? 'active' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && <em>{count}</em>}
    </button>
  )
}

export function Sidebar({ page, user, creationCount, open, collapsed, onNavigate, onToggleCollapse, onLogout }: {
  page: Page
  user: User
  creationCount: number
  open: boolean
  /** Thu gọn thành rail chỉ có icon (desktop). */
  collapsed: boolean
  onNavigate: (page: Page) => void
  onToggleCollapse: () => void
  onLogout: () => void
}) {
  const initials = user.email.slice(0, 2).toUpperCase()
  const { t } = useTranslation(shellCatalog)

  return (
    <aside className={`sidebar ${open ? 'sidebar-open' : ''} ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="brand-lockup">
        <div className="brand-mark"><Sparkles size={19} strokeWidth={2.4} /></div>
        <div className="brand-copy">
          <div className="brand-name">lumina<span>.</span></div>
          <div className="brand-caption">{t('brandCaption')}</div>
        </div>
        <button
          type="button"
          className="sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          title={collapsed ? t('sidebarExpand') : t('sidebarCollapse')}
          aria-label={collapsed ? t('sidebarExpand') : t('sidebarCollapse')}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <div className="workspace-switcher">
        <div className="workspace-avatar">{initials.slice(0, 1)}</div>
        <div className="workspace-copy">
          <strong>{t('workspacePersonal')}</strong>
          <span>{t('workspacePersonalCaption')}</span>
        </div>
        <ChevronDown size={15} className="muted-icon" />
      </div>

      <nav className="primary-nav">
        <div className="nav-label">{t('navSectionWorkspace')}</div>
        <NavItem
          icon={<WandSparkles size={17} />}
          label={t('navQuick')}
          active={page === 'quick'}
          onClick={() => onNavigate('quick')}
        />
        <NavItem
          icon={<Clapperboard size={17} />}
          label={t('navStudio')}
          active={page === 'studio'}
          onClick={() => onNavigate('studio')}
        />
        <NavItem
          icon={<Users size={17} />}
          label={t('navCharacters')}
          active={page === 'characters'}
          onClick={() => onNavigate('characters')}
        />
        <NavItem
          icon={<LayoutGrid size={17} />}
          label={t('navLibrary')}
          active={page === 'library'}
          count={creationCount}
          onClick={() => onNavigate('library')}
        />
        {/* Đặt sau "Thư viện" để không đổi thứ tự các mục đã có. */}
        <NavItem
          icon={<Sparkles size={17} />}
          label={t('navPlanner')}
          active={page === 'planner'}
          onClick={() => onNavigate('planner')}
        />
        {/* Timeline là trang riêng: storyboard nằm ngang, rộng hơn drawer cũ. */}
        <NavItem
          icon={<GalleryHorizontalEnd size={17} />}
          label={t('navTimeline')}
          active={page === 'timeline'}
          onClick={() => onNavigate('timeline')}
        />
      </nav>

      <nav className="primary-nav nav-secondary">
        <div className="nav-label">{t('navSectionManage')}</div>
        <NavItem
          icon={<KeyRound size={17} />}
          label={t('navApiModels')}
          active={page === 'settings'}
          onClick={() => onNavigate('settings')}
        />
        <NavItem
          icon={<Layers3 size={17} />}
          label={t('navCollections')}
          onClick={() => onNavigate('library')}
        />
      </nav>

      <div className="sidebar-bottom">
        <div className="plan-card">
          <div className="plan-icon"><Zap size={15} fill="currentColor" /></div>
          <div className="plan-text">
            <strong>{t('planApiKeyTitle')}</strong>
            <span>{t('planApiKeyCaption')}</span>
          </div>
          <ArrowUpRight size={14} className="plan-arrow" />
        </div>
        <div className="user-row">
          <div className="user-avatar">{initials}</div>
          <div className="user-info">
            <strong title={user.email}>{user.email}</strong>
            <span>{t('signedIn')}</span>
          </div>
          <button className="row-more" onClick={onLogout} aria-label={t('logout')} title={t('logout')}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}

export function Topbar({ page, onToggleNav, onNotify }: {
  page: Page
  onToggleNav: () => void
  onNotify: (message: Notification) => void
}) {
  const { t } = useTranslation(shellCatalog)
  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onToggleNav} aria-label={t('openMenu')}>
        <Menu size={20} />
      </button>
      <div className="breadcrumb">
        <span>{t('navSectionWorkspace')}</span>
        <span className="breadcrumb-separator">/</span>
        <strong>{t(PAGE_LABEL_KEYS[page])}</strong>
      </div>
      <div className="topbar-actions">
        <LanguageSwitcher />
        <button className="help-link" onClick={() => onNotify(notification('shell', 'helpMessage'))}>
          <CircleHelp size={16} /> {t('help')}
        </button>
      </div>
    </header>
  )
}
