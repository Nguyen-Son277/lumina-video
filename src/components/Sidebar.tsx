import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  KeyRound,
  Layers3,
  LayoutGrid,
  Menu,
  Sparkles,
  Trash2,
  Users,
  WandSparkles,
  Zap,
} from 'lucide-react'
import type { User } from '../api/types'

export type Page = 'quick' | 'studio' | 'characters' | 'library' | 'planner' | 'settings'

export function NavItem({ icon, label, active, count, onClick }: {
  icon: ReactNode
  label: string
  active?: boolean
  count?: number
  onClick: () => void
}) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {count !== undefined && <em>{count}</em>}
    </button>
  )
}

export function Sidebar({ page, user, creationCount, open, onNavigate, onLogout }: {
  page: Page
  user: User
  creationCount: number
  open: boolean
  onNavigate: (page: Page) => void
  onLogout: () => void
}) {
  const initials = user.email.slice(0, 2).toUpperCase()

  return (
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand-lockup">
        <div className="brand-mark"><Sparkles size={19} strokeWidth={2.4} /></div>
        <div>
          <div className="brand-name">lumina<span>.</span></div>
          <div className="brand-caption">CREATIVE WORKSPACE</div>
        </div>
      </div>

      <div className="workspace-switcher">
        <div className="workspace-avatar">{initials.slice(0, 1)}</div>
        <div className="workspace-copy">
          <strong>Workspace cá nhân</strong>
          <span>Tài khoản riêng của bạn</span>
        </div>
        <ChevronDown size={15} className="muted-icon" />
      </div>

      <nav className="primary-nav">
        <div className="nav-label">Workspace</div>
        <NavItem
          icon={<WandSparkles size={17} />}
          label="Tạo nội dung đơn lẻ"
          active={page === 'quick'}
          onClick={() => onNavigate('quick')}
        />
        <NavItem
          icon={<Clapperboard size={17} />}
          label="Studio"
          active={page === 'studio'}
          onClick={() => onNavigate('studio')}
        />
        <NavItem
          icon={<Users size={17} />}
          label="Nhân vật"
          active={page === 'characters'}
          onClick={() => onNavigate('characters')}
        />
        <NavItem
          icon={<LayoutGrid size={17} />}
          label="Thư viện"
          active={page === 'library'}
          count={creationCount}
          onClick={() => onNavigate('library')}
        />
        {/* Đặt sau "Thư viện" để không đổi thứ tự các mục đã có. */}
        <NavItem
          icon={<Sparkles size={17} />}
          label="Trợ lý AI"
          active={page === 'planner'}
          onClick={() => onNavigate('planner')}
        />
      </nav>

      <nav className="primary-nav nav-secondary">
        <div className="nav-label">Quản lý</div>
        <NavItem
          icon={<KeyRound size={17} />}
          label="API & Models"
          active={page === 'settings'}
          onClick={() => onNavigate('settings')}
        />
        <NavItem
          icon={<Layers3 size={17} />}
          label="Collections"
          onClick={() => onNavigate('library')}
        />
      </nav>

      <div className="sidebar-bottom">
        <div className="plan-card">
          <div className="plan-icon"><Zap size={15} fill="currentColor" /></div>
          <div className="plan-text">
            <strong>API key của bạn</strong>
            <span>Key được mã hóa và chỉ dùng để gọi provider.</span>
          </div>
          <ArrowUpRight size={14} className="plan-arrow" />
        </div>
        <div className="user-row">
          <div className="user-avatar">{initials}</div>
          <div className="user-info">
            <strong title={user.email}>{user.email}</strong>
            <span>Đã đăng nhập</span>
          </div>
          <button className="row-more" onClick={onLogout} aria-label="Đăng xuất" title="Đăng xuất">
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
  onNotify: (message: string) => void
}) {
  const label =
    page === 'studio'
      ? 'Studio'
      : page === 'quick'
        ? 'Tạo nội dung đơn lẻ'
        : page === 'characters'
          ? 'Nhân vật'
          : page === 'library'
            ? 'Thư viện'
            : page === 'planner'
              ? 'Trợ lý AI'
              : 'API & Models'
  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onToggleNav} aria-label="Mở menu">
        <Menu size={20} />
      </button>
      <div className="breadcrumb">
        <span>Workspace</span>
        <span className="breadcrumb-separator">/</span>
        <strong>{label}</strong>
      </div>
      <div className="topbar-actions">
        <button className="help-link" onClick={() => onNotify('Mọi thao tác đều dùng API key của bạn.')}>
          <CircleHelp size={16} /> Trợ giúp
        </button>
      </div>
    </header>
  )
}
