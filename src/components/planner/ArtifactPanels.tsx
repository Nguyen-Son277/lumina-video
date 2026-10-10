import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { isErrorMessageKey, resolveErrorMessageKey } from '../../../shared/errorCatalog'
import { errorMessage, storedErrorMessage } from '../../api/client'
import { generationApi } from '../../api/endpoints'
import {
  plannerApi,
  uploadUrl,
  type CastMember,
  type DraftScene,
  type PlanSession,
  type TimelineFrame,
  type Voice,
} from '../../api/planner'
import { ActionLabel, AsyncOverlay, ListSkeleton } from './PlannerLoading'
import { ImageLightbox } from '../Lightbox'
import { plannerCatalog } from '../../i18n/catalogs/planner'
import { notification, type Notification } from '../../i18n/messages'
import { useTranslation } from '../../i18n/useTranslation'
import type { CatalogKey, MessageParams, Translate } from '../../i18n/types'

/** Khoá dịch của khu vực planner (dùng chung cho descriptor lỗi nội bộ). */
type PlannerKey = CatalogKey<typeof plannerCatalog>

/**
 * Lỗi do giao diện tự sinh: giữ khoá dịch + tham số thay vì câu đã dịch.
 *
 * Descriptor đi qua `onError` giữa các file trong khu vực planner; trang cha gọi
 * `plannerErrorText` ngay tại chỗ render nên đổi ngôn ngữ là dịch lại, còn nội
 * dung thô của provider/AI/người dùng vẫn nguyên vẹn.
 */
export type PlannerErrorDescriptor = { key: PlannerKey; params?: MessageParams }

/** Descriptor cho một khoá dịch nội bộ đã biết. */
export function localizedPlannerError(
  key: PlannerKey,
  params?: MessageParams,
): PlannerErrorDescriptor {
  return { key, params }
}

/** Nhận diện descriptor khoá dịch (khác `Error` và nội dung thô). */
export function isPlannerErrorDescriptor(value: unknown): value is PlannerErrorDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { key?: unknown }).key === 'string'
  )
}

/** Trường lỗi đã lưu trên server (generation, item batch) mà `storedErrorMessage` đọc. */
type StoredErrorFields = {
  errorCode?: string | null
  errorMessage?: string | null
  errorMessageKey?: string | null
  errorMessageParams?: Record<string, string | number> | null
}

/**
 * Câu lỗi hiển thị theo ngôn ngữ hiện tại.
 *
 * - descriptor nội bộ → dịch từ `plannerCatalog` (đổi ngôn ngữ là đổi ngay);
 * - `Error`/`ApiError` → `errorMessage` (khoá ngữ nghĩa nếu có, giữ nguyên văn lỗi thô);
 * - lỗi đã lưu trên server → `storedErrorMessage` (tiêu đề dịch, nội dung thô tách riêng).
 */
export function plannerErrorText(value: unknown, t: Translate<typeof plannerCatalog>): string {
  if (value === null || value === undefined || value === '') return ''
  if (isPlannerErrorDescriptor(value)) return t(value.key, value.params)
  if (value instanceof Error) return errorMessage(value)
  const stored = value as StoredErrorFields
  const key = resolveErrorMessageKey(
    stored.errorMessage ?? '',
    stored.errorCode,
    isErrorMessageKey(stored.errorMessageKey) ? stored.errorMessageKey : undefined,
  )
  // Không suy được khoá ngữ nghĩa: giữ nguyên văn thô của provider (không dịch máy).
  if (key === 'errors.unknown' && stored.errorMessage) return stored.errorMessage
  return storedErrorMessage(stored) || errorMessage(value)
}

/** Props chung của ba panel trong drawer artifact. */
type PanelProps = {
  session: PlanSession
  /** Trạng thái bận chung của trang (chat hoặc thao tác khác đang chạy). */
  busy: string
  /** Câu lỗi đã dịch theo ngôn ngữ hiện tại (trang cha dịch khi render). */
  error: string
  onSession: (session: PlanSession) => void
  onReload: () => Promise<unknown>
  onNotify: (message: Notification) => void
  /**
   * Nhận lỗi ở dạng thô: `Error`/`ApiError` của API, descriptor khoá dịch nội bộ,
   * hoặc đối tượng lỗi đã lưu trên server. Trang cha dịch khi render.
   */
  onError: (error: unknown) => void
}


/**
 * Sinh ảnh cho một mục (chân dung / nền): gọi model ảnh, chờ tác vụ xong rồi gắn.
 *
 * Tác vụ chạy nền nên giao diện theo dõi tiến trình và hiện khung chờ, thay vì
 * giữ một request dài.
 */
function useArtifactImage(options: {
  sessionId: string
  onSession: (session: PlanSession) => void
  /** Nhận lỗi thô/descriptor; trang cha dịch theo ngôn ngữ hiện tại. */
  onError: (error: unknown) => void
}) {
  const { sessionId, onSession, onError } = options
  const [busyId, setBusyId] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const generate = useCallback(
    async (
      key: string,
      start: () => Promise<{ generation: { id: string } }>,
      attach: (generationId: string) => Promise<{ session: PlanSession }>,
    ) => {
      setBusyId(key)
      try {
        const { generation } = await start()
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          if (!alive.current) return
          const current = (await generationApi.get(generation.id)).generation
          if (current.status === 'succeeded') {
            const result = await attach(generation.id)
            if (alive.current) onSession(result.session)
            return
          }
          if (current.status === 'failed' || current.status === 'unknown') {
            // Lỗi đã lưu kèm khoá ngữ nghĩa thì giữ nguyên đối tượng để dịch khi render.
            if (alive.current) {
              onError(
                current.errorMessage || current.errorMessageKey || current.errorCode
                  ? current
                  : localizedPlannerError('imageGenerateFailedRetry'),
              )
            }
            return
          }
        }
        if (alive.current) onError(localizedPlannerError('imageTooLong'))
      } catch (cause) {
        if (alive.current) {
          onError(cause instanceof Error ? cause : localizedPlannerError('imageGenerateFailed'))
        }
      } finally {
        if (alive.current) setBusyId('')
      }
    },
    [onError, onSession],
  )

  return { busyId, generate, sessionId }
}

/** Một ô nhập nhỏ trong bảng timeline / danh sách cảnh. */
function Cell({
  label,
  value,
  onChange,
  rows = 2,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows?: number
}) {
  return (
    <label className="plan-cell">
      <span>{label}</span>
      <textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

/** Tab 1: chat + kịch bản nháp (text ở trên, danh sách cảnh có cấu trúc ở dưới). */
export function ScriptPanel(props: PanelProps & { onGoCast: () => void }) {
  const { session, busy, error, onSession, onReload, onNotify, onError, onGoCast } = props
  const { t } = useTranslation(plannerCatalog)
  const [text, setText] = useState(session.script?.text ?? '')
  const [scenes, setScenes] = useState<DraftScene[]>(session.script?.scenes ?? [])

  useEffect(() => {
    setText(session.script?.text ?? '')
    setScenes(session.script?.scenes ?? [])
  }, [session.script])

  const [localBusy, setLocalBusy] = useState('')
  const anyBusy = busy !== '' || localBusy !== ''
  const working = localBusy === 'rewrite'

  async function save(): Promise<void> {
    try {
      const result = await plannerApi.saveScript(session.id, { text, scenes })
      onSession(result.session)
      await onReload()
      onNotify(notification('planner', 'scriptSaved'))
    } catch (cause) {
      onError(cause instanceof Error ? cause : localizedPlannerError('scriptSaveFailed'))
    }
  }

  function updateScene(index: number, patch: Partial<DraftScene>): void {
    setScenes((current) => current.map((scene, i) => (i === index ? { ...scene, ...patch } : scene)))
  }

  return (
    <section className="plan-draft">
        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="plan-draft-head">
          <strong>{t('draftScriptHeading')}</strong>
          <div className="plan-actions">
            <button
              type="button"
              className="primary-small-button"
              disabled={anyBusy}
              onClick={async () => {
                setLocalBusy('rewrite')
                try {
                  const result = await plannerApi.rewriteScript(session.id)
                  onSession(result.session)
                  await onReload()
                } catch (cause) {
                  onError(cause instanceof Error ? cause : localizedPlannerError('scriptGenerateFailed'))
                } finally {
                  setLocalBusy('')
                }
              }}
            >
              <ActionLabel
                busy={working}
                idle={session.script ? t('rewriteScript') : t('aiWriteScript')}
                working={t('writingScript')}
              />
            </button>
            <button type="button" className="secondary-button" disabled={anyBusy} onClick={() => void save()}>
              {busy === 'script:save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} {t('saveDraft')}
            </button>
          </div>
        </div>

        {working && <AsyncOverlay label={t('scriptWorkingOverlay')} />}

        <label className="plan-cell">
          <span>{t('scriptTextLabel')}</span>
          <textarea
            rows={10}
            value={text}
            placeholder={t('scriptTextPlaceholder')}
            onChange={(event) => setText(event.target.value)}
          />
        </label>

        {working && !scenes.length && <ListSkeleton rows={3} />}

        <div className="plan-scenes">
          {scenes.map((scene, index) => (
            <article className="plan-scene" key={scene.id}>
              <div className="plan-scene-head">
                <span className="plan-scene-index">{t('sceneIndex', { index: index + 1 })}</span>
                <input
                  value={scene.title}
                  aria-label={t('sceneTitleLabel', { index: index + 1 })}
                  onChange={(event) => updateScene(index, { title: event.target.value })}
                />
                <label className="plan-seconds">
                  <span>{t('secondsShort')}</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={scene.durationSeconds}
                    aria-label={t('sceneDurationLabel', { index: index + 1 })}
                    onChange={(event) =>
                      updateScene(index, { durationSeconds: Number(event.target.value) || 1 })
                    }
                  />
                </label>
              </div>
              <Cell
                label={t('fieldContext')}
                value={scene.context}
                onChange={(value) => updateScene(index, { context: value })}
              />
              <Cell
                label={t('fieldAction')}
                value={scene.action}
                onChange={(value) => updateScene(index, { action: value })}
              />
              <Cell
                label={t('fieldBeats')}
                value={scene.beats ?? ''}
                onChange={(value) => updateScene(index, { beats: value })}
              />
              <Cell
                label={t('fieldDialogue')}
                value={scene.dialogue}
                onChange={(value) => updateScene(index, { dialogue: value })}
              />
              <div className="plan-row">
                <label className="plan-cell">
                  <span>{t('sceneCharactersLabel')}</span>
                  <input
                    value={scene.characters.join(', ')}
                    onChange={(event) =>
                      updateScene(index, {
                        characters: event.target.value
                          .split(',')
                          .map((name) => name.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label className="plan-cell">
                  <span>{t('fieldSpeaker')}</span>
                  <input
                    value={scene.speaker}
                    onChange={(event) => updateScene(index, { speaker: event.target.value })}
                  />
                </label>
              </div>
            </article>
          ))}
        </div>

        <div className="plan-draft-footer">
          <button type="button" className="generate-button" disabled={anyBusy} onClick={onGoCast}>
            <ArrowRight size={15} /> {t('goCast')}
          </button>
        </div>
    </section>
  )
}

/** Tab 2: ý tưởng nhân vật — sửa trực tiếp, sinh ảnh chân dung, chọn nơi lưu. */
export function CastPanel(props: PanelProps & { onGoTimeline: () => void }) {
  const { session, busy, error, onSession, onReload, onNotify, onError, onGoTimeline } = props
  const { t } = useTranslation(plannerCatalog)
  const [cast, setCast] = useState<CastMember[]>(session.cast)
  /** Ảnh chân dung đang xem lớn: giữ url + tên thô, dịch alt khi render. */
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null)
  const [localBusy, setLocalBusy] = useState('')
  const anyBusy = busy !== '' || localBusy !== ''
  const working = localBusy === 'generate'
  const { busyId, generate } = useArtifactImage({ sessionId: session.id, onSession, onError })

  useEffect(() => {
    setCast(session.cast)
  }, [session.cast])

  function update(index: number, patch: Partial<CastMember>): void {
    setCast((current) => current.map((member, i) => (i === index ? { ...member, ...patch } : member)))
  }

  async function save(): Promise<void> {
    try {
      const result = await plannerApi.saveCast(session.id, cast)
      onSession(result.session)
      onNotify(notification('planner', 'castSaved'))
    } catch (cause) {
      onError(cause instanceof Error ? cause : localizedPlannerError('castSaveFailed'))
    }
  }

  return (
    <section className="plan-draft">
        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="plan-draft-head">
          <strong>{t('castHeading')}</strong>
          <div className="plan-actions">
            <button
              type="button"
              className="primary-small-button"
              disabled={anyBusy}
              onClick={async () => {
                setLocalBusy('generate')
                try {
                  const result = await plannerApi.generateCast(session.id)
                  onSession(result.session)
                  await onReload()
                } catch (cause) {
                  onError(cause instanceof Error ? cause : localizedPlannerError('castGenerateFailed'))
                } finally {
                  setLocalBusy('')
                }
              }}
            >
              <ActionLabel
                busy={working}
                idle={cast.length ? t('regenerateWithAi') : t('aiSuggestCast')}
                working={t('generatingCast')}
              />
            </button>
            <button type="button" className="secondary-button" disabled={anyBusy} onClick={() => void save()}>
              <Save size={15} /> {t('save')}
            </button>
          </div>
        </div>

        {working && <AsyncOverlay label={t('castWorkingOverlay')} />}
        {working && !cast.length && <ListSkeleton rows={2} />}

        <div className="plan-cast">
          {cast.map((member, index) => (
            <article className="plan-cast-member" key={member.id}>
              <div className="plan-portrait">
                {member.portrait ? (
                  <button
                    type="button"
                    className="illustration-zoom"
                    title={t('zoomImage')}
                    aria-label={t('zoomPortraitOf', { name: member.name })}
                    onClick={() =>
                      setZoom({
                        url: uploadUrl(member.portrait!.uploadId),
                        name: member.name,
                      })
                    }
                  >
                    <img src={uploadUrl(member.portrait.uploadId)} alt={t('portraitAlt', { name: member.name })} />
                  </button>
                ) : busyId === `portrait:${member.id}` ? (
                  <div className="plan-portrait-loading">
                    <LoaderCircle size={16} className="spin" />
                    <span>{t('generatingImage')}</span>
                  </div>
                ) : (
                  <div className="plan-portrait-empty">
                    <ImageIcon size={16} />
                    <span>{t('noImage')}</span>
                  </div>
                )}
                <div className="plan-portrait-actions">
                  <button
                    type="button"
                    className="row-action"
                    disabled={busyId !== '' || anyBusy}
                    onClick={() =>
                      void generate(
                        `portrait:${member.id}`,
                        () => plannerApi.generatePortrait(session.id, member.id),
                        (generationId) => plannerApi.attachPortrait(session.id, member.id, generationId),
                      )
                    }
                  >
                    <Sparkles size={13} /> {t('generateImage')}
                  </button>
                  <label className="row-action plan-upload">
                    <Upload size={13} /> {t('uploadImage')}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={async (event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (!file) return
                        try {
                          const result = await plannerApi.uploadPortrait(session.id, member.id, file)
                          onSession(result.session)
                        } catch (cause) {
                          onError(cause instanceof Error ? cause : localizedPlannerError('imageUploadFailed'))
                        }
                      }}
                    />
                  </label>
                  {member.portrait && (
                    <button
                      type="button"
                      className="row-action"
                      disabled={busyId !== '' || anyBusy}
                      onClick={async () => {
                        try {
                          const result = await plannerApi.removePortrait(session.id, member.id)
                          onSession(result.session)
                        } catch (cause) {
                          onError(cause instanceof Error ? cause : localizedPlannerError('imageRemoveFailed'))
                        }
                      }}
                    >
                      <Trash2 size={13} /> {t('delete')}
                    </button>
                  )}
                </div>
              </div>

              <div className="plan-cast-fields">
                <label className="plan-cell">
                  <span>{t('fieldName')}</span>
                  <input value={member.name} onChange={(event) => update(index, { name: event.target.value })} />
                </label>
                <label className="plan-cell">
                  <span>{t('fieldRole')}</span>
                  <input value={member.role} onChange={(event) => update(index, { role: event.target.value })} />
                </label>
                <Cell
                  label={t('fieldAppearance')}
                  value={member.appearance}
                  onChange={(value) => update(index, { appearance: value })}
                />
                <label className="plan-cell">
                  <span>{t('storageLabel')}</span>
                  <select
                    value={member.storage}
                    onChange={(event) =>
                      update(index, { storage: event.target.value as CastMember['storage'] })
                    }
                  >
                    <option value="library">{t('storageLibrary')}</option>
                    <option value="project">{t('storageProject')}</option>
                  </select>
                </label>
                <div className="plan-actions">
                  <button
                    type="button"
                    className="row-more"
                    aria-label={t('removeCharacterAria', { name: member.name })}
                    onClick={() => setCast((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} /> {t('removeCharacter')}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>

        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            setCast((current) => [
              ...current,
              {
                id: `local-${Date.now()}`,
                name: t('newCharacterName'),
                appearance: '',
                role: '',
                voice: {} as Voice,
                reuseCharacterId: null,
                storage: 'library',
                portrait: null,
              },
            ])
          }
        >
          <Plus size={15} /> {t('addCharacter')}
        </button>

        <div className="plan-draft-footer">
          <button type="button" className="generate-button" disabled={anyBusy} onClick={onGoTimeline}>
            <ArrowRight size={15} /> {t('goTimeline')}
          </button>
        </div>

        {zoom && (
          <ImageLightbox
            src={zoom.url}
            alt={t('portraitReferenceAlt', { name: zoom.name })}
            downloadHref={zoom.url}
            onClose={() => setZoom(null)}
          />
        )}
    </section>
  )
}

/** Tab 3: timeline từng frame (thời gian · bối cảnh · ảnh nền · nhân vật) + chốt dự án. */
export type { PanelProps }
