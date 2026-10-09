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

/** Props chung của ba panel trong drawer artifact. */
type PanelProps = {
  session: PlanSession
  /** Trạng thái bận chung của trang (chat hoặc thao tác khác đang chạy). */
  busy: string
  error: string
  onSession: (session: PlanSession) => void
  onReload: () => Promise<unknown>
  onNotify: (message: string) => void
  onError: (message: string) => void
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
  onError: (message: string) => void
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
          const current = (await generationApi.get(generation.id)).generation as {
            status: string
            errorMessage?: string | null
          }
          if (current.status === 'succeeded') {
            const result = await attach(generation.id)
            if (alive.current) onSession(result.session)
            return
          }
          if (current.status === 'failed' || current.status === 'unknown') {
            throw new Error(current.errorMessage || 'Tạo ảnh thất bại. Hãy thử lại.')
          }
        }
        throw new Error('Tạo ảnh quá lâu. Hãy kiểm tra lại sau.')
      } catch (cause) {
        if (alive.current) onError(cause instanceof Error ? cause.message : 'Tạo ảnh thất bại')
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
      onNotify('Đã lưu kịch bản nháp.')
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Không lưu được kịch bản')
    }
  }

  function updateScene(index: number, patch: Partial<DraftScene>): void {
    setScenes((current) => current.map((scene, i) => (i === index ? { ...scene, ...patch } : scene)))
  }

  return (
    <section className="plan-draft">
        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="plan-draft-head">
          <strong>Kịch bản nháp</strong>
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
                  onError(cause instanceof Error ? cause.message : 'AI không viết được kịch bản')
                } finally {
                  setLocalBusy('')
                }
              }}
            >
              <ActionLabel
                busy={working}
                idle={session.script ? 'Viết lại kịch bản' : 'AI viết kịch bản'}
                working="Đang viết kịch bản…"
              />
            </button>
            <button type="button" className="secondary-button" disabled={anyBusy} onClick={() => void save()}>
              {busy === 'script:save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Lưu nháp
            </button>
          </div>
        </div>

        {working && <AsyncOverlay label="AI đang viết kịch bản từ hội thoại và bản nháp hiện tại" />}

        <label className="plan-cell">
          <span>Bản kịch bản (sửa trực tiếp)</span>
          <textarea
            rows={10}
            value={text}
            placeholder="Bấm “AI viết kịch bản” hoặc tự nhập kịch bản của bạn."
            onChange={(event) => setText(event.target.value)}
          />
        </label>

        {working && !scenes.length && <ListSkeleton rows={3} />}

        <div className="plan-scenes">
          {scenes.map((scene, index) => (
            <article className="plan-scene" key={scene.id}>
              <div className="plan-scene-head">
                <span className="plan-scene-index">Cảnh {index + 1}</span>
                <input
                  value={scene.title}
                  aria-label={`Tiêu đề cảnh ${index + 1}`}
                  onChange={(event) => updateScene(index, { title: event.target.value })}
                />
                <label className="plan-seconds">
                  <span>giây</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={scene.durationSeconds}
                    aria-label={`Thời lượng cảnh ${index + 1}`}
                    onChange={(event) =>
                      updateScene(index, { durationSeconds: Number(event.target.value) || 1 })
                    }
                  />
                </label>
              </div>
              <Cell
                label="Bối cảnh"
                value={scene.context}
                onChange={(value) => updateScene(index, { context: value })}
              />
              <Cell
                label="Hành động"
                value={scene.action}
                onChange={(value) => updateScene(index, { action: value })}
              />
              <Cell
                label="Lời thoại"
                value={scene.dialogue}
                onChange={(value) => updateScene(index, { dialogue: value })}
              />
              <div className="plan-row">
                <label className="plan-cell">
                  <span>Nhân vật (cách nhau dấu phẩy)</span>
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
                  <span>Người nói</span>
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
            <ArrowRight size={15} /> Tạo ý tưởng nhân vật
          </button>
        </div>
    </section>
  )
}

/** Tab 2: ý tưởng nhân vật — sửa trực tiếp, sinh ảnh chân dung, chọn nơi lưu. */
export function CastPanel(props: PanelProps & { onGoTimeline: () => void }) {
  const { session, busy, error, onSession, onReload, onNotify, onError, onGoTimeline } = props
  const [cast, setCast] = useState<CastMember[]>(session.cast)
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null)
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
      onNotify('Đã lưu ý tưởng nhân vật.')
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Không lưu được nhân vật')
    }
  }

  return (
    <section className="plan-draft">
        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="plan-draft-head">
          <strong>Ý tưởng nhân vật</strong>
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
                  onError(cause instanceof Error ? cause.message : 'AI không đề xuất được nhân vật')
                } finally {
                  setLocalBusy('')
                }
              }}
            >
              <ActionLabel
                busy={working}
                idle={cast.length ? 'Tạo lại bằng AI' : 'AI đề xuất nhân vật'}
                working="Đang tạo nhân vật…"
              />
            </button>
            <button type="button" className="secondary-button" disabled={anyBusy} onClick={() => void save()}>
              <Save size={15} /> Lưu
            </button>
          </div>
        </div>

        {working && <AsyncOverlay label="AI đang đọc kịch bản và đề xuất nhân vật kèm hồ sơ giọng" />}
        {working && !cast.length && <ListSkeleton rows={2} />}

        <div className="plan-cast">
          {cast.map((member, index) => (
            <article className="plan-cast-member" key={member.id}>
              <div className="plan-portrait">
                {member.portrait ? (
                  <button
                    type="button"
                    className="illustration-zoom"
                    title="Xem ảnh phóng to"
                    aria-label={`Xem ảnh phóng to của ${member.name}`}
                    onClick={() =>
                      setZoom({
                        url: uploadUrl(member.portrait!.uploadId),
                        alt: `Ảnh tham chiếu của ${member.name}`,
                      })
                    }
                  >
                    <img src={uploadUrl(member.portrait.uploadId)} alt={`Ảnh ${member.name}`} />
                  </button>
                ) : busyId === `portrait:${member.id}` ? (
                  <div className="plan-portrait-loading">
                    <LoaderCircle size={16} className="spin" />
                    <span>Đang sinh ảnh…</span>
                  </div>
                ) : (
                  <div className="plan-portrait-empty">
                    <ImageIcon size={16} />
                    <span>Chưa có ảnh</span>
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
                    <Sparkles size={13} /> Sinh ảnh
                  </button>
                  <label className="row-action plan-upload">
                    <Upload size={13} /> Tải ảnh
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
                          onError(cause instanceof Error ? cause.message : 'Không tải được ảnh')
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
                          onError(cause instanceof Error ? cause.message : 'Không xoá được ảnh')
                        }
                      }}
                    >
                      <Trash2 size={13} /> Xoá
                    </button>
                  )}
                </div>
              </div>

              <div className="plan-cast-fields">
                <label className="plan-cell">
                  <span>Tên</span>
                  <input value={member.name} onChange={(event) => update(index, { name: event.target.value })} />
                </label>
                <label className="plan-cell">
                  <span>Vai</span>
                  <input value={member.role} onChange={(event) => update(index, { role: event.target.value })} />
                </label>
                <Cell
                  label="Ngoại hình"
                  value={member.appearance}
                  onChange={(value) => update(index, { appearance: value })}
                />
                <label className="plan-cell">
                  <span>Nơi lưu khi chốt dự án</span>
                  <select
                    value={member.storage}
                    onChange={(event) =>
                      update(index, { storage: event.target.value as CastMember['storage'] })
                    }
                  >
                    <option value="library">Thư viện dùng chung</option>
                    <option value="project">Chỉ dự án này</option>
                  </select>
                </label>
                <div className="plan-actions">
                  <button
                    type="button"
                    className="row-more"
                    aria-label={`Xoá ${member.name}`}
                    onClick={() => setCast((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} /> Bỏ nhân vật
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
                name: 'Nhân vật mới',
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
          <Plus size={15} /> Thêm nhân vật
        </button>

        <div className="plan-draft-footer">
          <button type="button" className="generate-button" disabled={anyBusy} onClick={onGoTimeline}>
            <ArrowRight size={15} /> Lên timeline
          </button>
        </div>

        {zoom && (
          <ImageLightbox
            src={zoom.url}
            alt={zoom.alt}
            downloadHref={zoom.url}
            onClose={() => setZoom(null)}
          />
        )}
    </section>
  )
}

/** Tab 3: timeline từng frame (thời gian · bối cảnh · ảnh nền · nhân vật) + chốt dự án. */
export type { PanelProps }
