import { useEffect, useRef } from 'react'
import { Check, LoaderCircle, Send, Sparkles, X } from 'lucide-react'
import type { PlanMessage, PlanSurface, ProposalChange } from '../../api/planner'
import { plannerCatalog } from '../../i18n/catalogs/planner'
import { useTranslation } from '../../i18n/useTranslation'
import type { CatalogKey } from '../../i18n/types'

/**
 * Cửa sổ chat cho hai bề mặt sửa được: timeline và bối cảnh & tính liên tục.
 *
 * Cùng một khung với chat ở trang Timeline (drawer từ mép phải, `.board-chat-log`
 * + `.planner-composer`), nhưng có thêm bước CHỐT: AI chỉ đề xuất, người dùng xem
 * danh sách thay đổi rồi mới bấm áp dụng.
 */

/** Nhãn hành động của một thay đổi trong thẻ đề xuất. */
const ACTION_KEYS: Record<ProposalChange['action'], CatalogKey<typeof plannerCatalog>> = {
  add: 'proposalActionAdd',
  update: 'proposalActionUpdate',
  remove: 'proposalActionRemove',
  assign: 'proposalActionAssign',
  unassign: 'proposalActionUnassign',
  reorder: 'proposalActionReorder',
  frame_update: 'proposalActionFrameUpdate',
}

/** Nhãn trường dữ liệu: dùng lại khoá có sẵn, còn lại hiển thị tên thô. */
const FIELD_KEYS: Record<string, CatalogKey<typeof plannerCatalog>> = {
  name: 'fieldName',
  stage: 'proposalFieldStage',
  description: 'proposalFieldDescription',
  continuityNotes: 'proposalFieldContinuity',
  imagePrompt: 'proposalFieldImagePrompt',
  title: 'proposalFieldTitle',
  context: 'fieldContext',
  action: 'fieldAction',
  dialogue: 'fieldDialogue',
  speaker: 'fieldSpeaker',
  durationSeconds: 'proposalFieldDuration',
  shotNotes: 'shotNotesLabel',
  beats: 'fieldBeats',
  locationId: 'proposalFieldLocation',
  characters: 'proposalFieldCharacters',
  order: 'proposalFieldOrder',
}

export type PendingProposal = {
  surface: PlanSurface
  summary: string
  changes: ProposalChange[]
}

export function SurfaceChatDrawer({
  open,
  surface,
  onSurfaceChange,
  title,
  messages,
  busy,
  blocked,
  draft,
  onDraftChange,
  onSend,
  pending,
  applying,
  onApply,
  onDiscard,
  onClose,
  errorText,
}: {
  open: boolean
  surface: PlanSurface
  onSurfaceChange: (surface: PlanSurface) => void
  title: string
  messages: PlanMessage[]
  busy: boolean
  blocked: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  pending: PendingProposal | null
  applying: boolean
  onApply: () => void
  onDiscard: () => void
  onClose: () => void
  errorText: string
}) {
  const { t } = useTranslation(plannerCatalog)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, busy, pending])

  // Ô nhập cao theo nội dung; trần do CSS lo.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
  }, [draft])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      )
    focusable()[0]?.focus()
    function keydown(event: KeyboardEvent) {
      // Esc đóng cửa sổ, trừ khi đang bận hoặc còn đề xuất chờ người dùng quyết định.
      const locked = busy || applying || pending !== null
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!locked) onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        event.preventDefault()
        dialog.current?.focus()
        return
      }
      const inside = dialog.current?.contains(document.activeElement) ?? false
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [open, busy, applying, pending, onClose])

  if (!open) return null

  function submit(): void {
    const content = draft.trim()
    if (!content || busy || blocked || pending) return
    onSend()
  }

  return (
    <div
      className="timeline-overlay is-drawer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={dialog} className="timeline-chat-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="timeline-overlay-head">
          <h2>{title}</h2>
          <button type="button" className="close-button" aria-label={t('closeChat')} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="surface-chat-tabs" role="tablist" aria-label={t('surfaceTabsAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={surface === 'timeline'}
            className={surface === 'timeline' ? 'active' : ''}
            disabled={busy}
            onClick={() => onSurfaceChange('timeline')}
          >
            {t('targetTimeline')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={surface === 'locations'}
            className={surface === 'locations' ? 'active' : ''}
            disabled={busy}
            onClick={() => onSurfaceChange('locations')}
          >
            {t('proposalSurfaceLocations')}
          </button>
        </div>

        {errorText && <div className="form-error" role="alert">{errorText}</div>}
        {blocked && <p className="surface-chat-blocked" role="status">{t('chatNeedsModel')}</p>}

        <div className="board-chat-log" ref={logRef} aria-live="polite">
          {messages.length === 0 ? (
            <p className="board-chat-empty">{t('surfaceChatEmpty')}</p>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`planner-bubble ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}
              >
                <div className="planner-bubble-role">
                  {message.role === 'user' ? t('senderYou') : t('eyebrowAiScript')}
                </div>
                <div className="planner-bubble-body">{message.content}</div>
              </div>
            ))
          )}
        </div>

        {pending && (
          <section className="surface-proposal" aria-label={t('proposalTitle')}>
            <header>
              <Sparkles size={15} />
              <strong>{t('proposalTitle')}</strong>
            </header>
            <p className="surface-proposal-summary">{pending.summary || t('proposalNoSummary')}</p>
            {pending.changes.length === 0 ? (
              <p className="surface-proposal-empty">{t('proposalNoChanges')}</p>
            ) : (
              <ul className="surface-proposal-changes">
                {pending.changes.map((change, index) => (
                  <li key={`${change.action}-${change.entity}-${change.id}-${index}`}>
                    <span className={`surface-change is-${change.action}`}>
                      {t(ACTION_KEYS[change.action])}
                    </span>
                    <span className="surface-change-entity">
                      {change.entity === 'location' ? t('proposalEntityLocation') : t('proposalEntityFrame')}
                    </span>
                    {change.label && <strong>{change.label}</strong>}
                    {change.fields.length > 0 && (
                      <ul className="surface-change-fields">
                        {change.fields.map((field) => (
                          <li key={`${field.field}-${field.from}-${field.to}`}>
                            <span className="surface-change-field">
                              {FIELD_KEYS[field.field] ? t(FIELD_KEYS[field.field]!) : field.field}
                            </span>
                            {field.from && <del>{field.from}</del>}
                            {field.to && <ins>{field.to}</ins>}
                            {!field.from && !field.to && <span className="is-muted">{t('proposalFieldEmpty')}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="surface-proposal-actions">
              <button
                type="button"
                className="generate-button"
                disabled={busy || applying || pending.changes.length === 0}
                onClick={onApply}
              >
                {applying ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} {t('proposalApply')}
              </button>
              <button type="button" className="secondary-button" disabled={busy || applying} onClick={onDiscard}>
                {t('proposalDiscard')}
              </button>
            </div>
          </section>
        )}

        {busy && (
          <div className="timeline-thinking">
            <LoaderCircle size={14} className="spin" /> {t('aiTyping')}
          </div>
        )}

        <div className="planner-composer">
          <textarea
            ref={inputRef}
            value={draft}
            disabled={busy || blocked || Boolean(pending)}
            maxLength={8000}
            aria-label={t('surfaceMessageAria')}
            placeholder={blocked ? t('chatNeedsModel') : t('surfaceComposerPlaceholder')}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            type="button"
            className="generate-button"
            disabled={busy || blocked || Boolean(pending) || !draft.trim()}
            onClick={submit}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />} {t('send')}
          </button>
        </div>
      </div>
    </div>
  )
}
