import { useEffect, useRef, useState, type ReactNode } from 'react'
import '../styles/sidebar-navigation.css'
import {
  ArrowUpRight,
  BarChart3,
  BookOpen,
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
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react'
import type { User } from '../api/types'
import { BrandMark } from './BrandMark'
import { LanguageSwitcher, useTranslation } from '../i18n'
import { shellCatalog, type ShellCatalogKey } from '../i18n/catalogs/shell'
import { IconButton } from './ui/Button'
import { useModalLayer } from './ui/useModalLayer'

const MOBILE_SIDEBAR_QUERY = '(max-width: 760px)'

/** Match the CSS drawer breakpoint without changing the saved desktop preference. */
function useMobileSidebar() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_SIDEBAR_QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia(MOBILE_SIDEBAR_QUERY)
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return mobile
}

export type Page = 'quick' | 'studio' | 'characters' | 'entities' | 'library' | 'planner' | 'planner-characters' | 'timeline' | 'usage' | 'trash' | 'settings' | 'account-settings' | 'admin-accounts' | 'admin-usage' | 'docs'

/** Khoá catalog cho nhãn từng trang (payload URL không đổi). */
const PAGE_LABEL_KEYS: Record<Page, ShellCatalogKey> = {
  docs: 'navDocs',
  quick: 'navQuick',
  studio: 'navStudio',
  characters: 'navCharacters',
  entities: 'navEntities',
  library: 'navLibrary',
  planner: 'navPlanner',
  'planner-characters': 'navCharacters',
  timeline: 'navTimeline',
  usage: 'navUsage',
  trash: 'navTrash',
  settings: 'navApiModels',
  'account-settings': 'navAccountSettings',
  'admin-accounts': 'navAdminAccounts',
  'admin-usage': 'navAdminUsage',
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

export function Sidebar({ page, user, creationCount, open, collapsed, onNavigate, onToggleCollapse, onLogout, onClose }: {
  page: Page
  user: User
  creationCount: number
  open: boolean
  /** Thu gọn thành rail chỉ có icon (desktop). */
  collapsed: boolean
  onNavigate: (page: Page) => void
  onToggleCollapse: () => void
  onLogout: () => void
  /** Đóng drawer trên điện thoại (nền mờ, nút X hoặc phím Escape). */
  onClose: () => void
}) {
  const initials = user.email.slice(0, 2).toUpperCase()
  const { t } = useTranslation(shellCatalog)

  const mobile = useMobileSidebar()
  const drawerOpen = mobile && open
  const desktopCollapsed = !mobile && collapsed
  const sidebarRef = useRef<HTMLElement>(null)

  // One shared owner handles Escape, visible focusables, focus return and body lock.
  // A closed drawer is inert, so its off-screen controls never enter the Tab order.
  useModalLayer(sidebarRef, onClose, { enabled: drawerOpen })
  useEffect(() => {
    if (!mobile && open) onClose()
  }, [mobile, open, onClose])

  return (
    <>
      {/* Nền mờ chỉ hiện ở mobile; bấm vào đây để đóng drawer. */}
      <div
        className={`sidebar-backdrop ${drawerOpen ? 'is-open' : ''}`}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        id="app-sidebar"
        ref={sidebarRef}
        className={`sidebar ${drawerOpen ? 'sidebar-open' : ''} ${desktopCollapsed ? 'is-collapsed' : ''}`}
        inert={mobile && !open}
        aria-hidden={mobile && !open ? true : undefined}
        role={drawerOpen ? 'dialog' : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? t('openMenu') : undefined}
        tabIndex={drawerOpen ? -1 : undefined}
      >
      <div className="brand-lockup">
        <BrandMark standalone={desktopCollapsed} />
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
        <button
          type="button"
          className="sidebar-mobile-close"
          onClick={onClose}
          title={t('closeMenu')}
          aria-label={t('closeMenu')}
        >
          <X size={18} />
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

      {user.role === 'admin' ? (
        <nav className="primary-nav">
          <div className="nav-label">{t('navSectionManage')}</div>
          <NavItem icon={<ShieldCheck size={17} />} label={t('navAdminAccounts')} active={page === 'admin-accounts'} onClick={() => onNavigate('admin-accounts')} />
          <NavItem icon={<BarChart3 size={17} />} label={t('navAdminUsage')} active={page === 'admin-usage'} onClick={() => onNavigate('admin-usage')} />
          <NavItem icon={<Settings size={17} />} label={t('navAccountSettings')} active={page === 'account-settings'} onClick={() => onNavigate('account-settings')} />
        </nav>
      ) : <>
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
          icon={<Layers3 size={17} />}
          label={t('navEntities')}
          active={page === 'entities'}
          onClick={() => onNavigate('entities')}
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
        {/* Nhật ký sử dụng: đặt cuối nhóm Quản lý để không đổi thứ tự mục cũ. */}
        <NavItem
          icon={<BarChart3 size={17} />}
          label={t('navUsage')}
          active={page === 'usage'}
          onClick={() => onNavigate('usage')}
        />
        <NavItem
          icon={<Trash2 size={17} />}
          label={t('navTrash')}
          active={page === 'trash'}
          onClick={() => onNavigate('trash')}
        />
        <NavItem icon={<Settings size={17} />} label={t('navAccountSettings')} active={page === 'account-settings'} onClick={() => onNavigate('account-settings')} />
      </nav>
      </>}

      <nav className="primary-nav nav-secondary" aria-label={t('navDocs')}>
        <NavItem icon={<BookOpen size={17} />} label={t('navDocs')} active={page === 'docs'} onClick={() => onNavigate('docs')} />
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
    </>
  )
}

export function Topbar({ page, navOpen, onToggleNav, onOpenDocs }: {
  page: Page
  navOpen: boolean
  onToggleNav: () => void
  onOpenDocs: () => void
}) {
  const { t } = useTranslation(shellCatalog)
  return (
    <header className="topbar">
      <IconButton
        type="button"
        className="mobile-menu"
        onClick={onToggleNav}
        label={t('openMenu')}
        aria-expanded={navOpen}
        aria-controls="app-sidebar"
      >
        <Menu size={20} />
      </IconButton>
      <div className="breadcrumb">
        <span>{t('navSectionWorkspace')}</span>
        <span className="breadcrumb-separator">/</span>
        <strong>{t(PAGE_LABEL_KEYS[page])}</strong>
      </div>
      <div className="topbar-actions">
        <LanguageSwitcher />
        <button className="help-link" onClick={onOpenDocs}>
          <CircleHelp size={16} /> {t('help')}
        </button>
      </div>
    </header>
  )
}
