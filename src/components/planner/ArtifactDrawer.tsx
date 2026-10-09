import { X } from 'lucide-react'
import type { PlanSession, PlanTarget } from '../../api/planner'
import { plannerCatalog } from '../../i18n/catalogs/planner'
import type { Notification } from '../../i18n/messages'
import { useTranslation } from '../../i18n/useTranslation'
import { CastPanel, PanelProps, ScriptPanel } from './ArtifactPanels'

/** Hai artifact còn mở trong drawer; Timeline đã thành trang riêng. */
type DrawerArtifact = Extract<PlanTarget, 'script' | 'cast'>

const TITLE_KEYS = {
  script: 'targetScript',
  cast: 'targetCast',
} as const satisfies Record<DrawerArtifact, string>

/**
 * Drawer chứa artifact của Tạo kịch bản AI.
 *
 * Mặc định đóng để chat giữ vai trò bề mặt chính; người dùng mở khi muốn xem hoặc
 * sửa tay kịch bản nháp, nhân vật hay timeline.
 */
export function ArtifactDrawer({
  artifact,
  session,
  busy,
  error,
  onClose,
  onSession,
  onReload,
  onNotify,
  onError,
  onSwitch,
  onOpenTimeline,
}: {
  /** `null` = drawer đang đóng. */
  artifact: DrawerArtifact | null
  session: PlanSession
  busy: string
  error: string
  onClose: () => void
  onSession: (session: PlanSession) => void
  onReload: () => Promise<unknown>
  onNotify: (message: Notification) => void
  onError: (error: unknown) => void
  /** Chuyển sang artifact khác khi người dùng bấm nút điều hướng trong panel. */
  onSwitch: (target: DrawerArtifact) => void
  /** Mở trang Timeline khi người dùng bấm "Lên timeline". */
  onOpenTimeline: () => void
}) {
  const open = artifact !== null
  const { t } = useTranslation(plannerCatalog)

  const panelProps: PanelProps = {
    session,
    busy,
    error,
    onSession,
    onReload,
    onNotify,
    onError,
  }

  return (
    <>
      <div
        className={`plan-drawer-backdrop ${open ? 'is-open' : ''}`}
        hidden={!open}
        onClick={onClose}
      />
      <aside
        className={`plan-drawer ${artifact ? `plan-drawer--${artifact}` : ''} ${open ? 'is-open' : ''}`}
        aria-hidden={!open}
        aria-label={artifact ? t(TITLE_KEYS[artifact]) : t('scriptPanelLabel')}
        // Drawer đóng thì bỏ khỏi luồng bàn phím để không chặn chat phía sau.
        inert={!open}
      >
        {artifact && (
          <>
            <header className="plan-drawer-head">
              <div>
                <div className="eyebrow"><span className="eyebrow-dot" /> {t('eyebrowAiScript')}</div>
                <h2>{t(TITLE_KEYS[artifact])}</h2>
              </div>
              <button type="button" className="close-button" onClick={onClose} aria-label={t('closePanel')}>
                <X size={18} />
              </button>
            </header>

            <div className="plan-drawer-body">
              {artifact === 'script' && (
                <ScriptPanel {...panelProps} onGoCast={() => onSwitch('cast')} />
              )}
              {artifact === 'cast' && (
                <CastPanel {...panelProps} onGoTimeline={onOpenTimeline} />
              )}
            </div>
          </>
        )}
      </aside>
    </>
  )
}
