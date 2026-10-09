import { useState } from 'react'
import { BrainCircuit, LoaderCircle, Plus, RefreshCw, Sparkles, X } from 'lucide-react'
import { errorMessage } from '../api/client'
import { characterApi } from '../api/endpoints'
import type { GeneratedCharacter } from '../api/projectTypes'
import type { LlmConnection, ModelInfo } from '../api/types'
import { IllustrationPanel, type IllustrationState } from './CharacterIllustrate'

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6]

const VOICE_LABELS: Array<{ key: keyof GeneratedCharacter['voice']; label: string }> = [
  { key: 'accent', label: 'Giọng' },
  { key: 'pitch', label: 'Cao độ' },
  { key: 'timbre', label: 'Âm sắc' },
  { key: 'pace', label: 'Tốc độ' },
]

/**
 * Modal sinh nhân vật mẫu bằng AI.
 *
 * Người dùng chỉ nhập mô tả; AI trả về vài nhân vật, người dùng chọn một để thêm
 * vào thư viện. Ứng viên chưa được lưu cho tới khi bấm thêm.
 */
export function CharacterAiModal({
  connections,
  models,
  onClose,
  onAdded,
  onOpenSettings,
  onNotify,
}: {
  connections: LlmConnection[]
  /** Model tạo ảnh hiện có, dùng để minh hoạ nhân vật mẫu. */
  models: ModelInfo[]
  onClose: () => void
  onAdded: (name: string) => void
  onOpenSettings: () => void
  onNotify: (message: string) => void
}) {
  const [description, setDescription] = useState('')
  const [count, setCount] = useState(3)
  // Ưu tiên kết nối đã kiểm tra thành công, nếu không lấy kết nối đầu tiên.
  const [connectionId, setConnectionId] = useState(
    connections.find((item) => item.status === 'connected')?.id ?? connections[0]?.id ?? '',
  )

  const [candidates, setCandidates] = useState<GeneratedCharacter[]>([])
  const [added, setAdded] = useState<string[]>([])
  /** Ảnh minh hoạ đã tạo cho từng ứng viên, khoá theo tên nhân vật. */
  const [illustrations, setIllustrations] = useState<Record<string, IllustrationState>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const hasConnection = connections.length > 0
  const canGenerate = hasConnection && Boolean(description.trim()) && !busy

  async function generate() {
    setBusy(true)
    setError('')
    try {
      const result = await characterApi.generate({
        description: description.trim(),
        count,
        language: 'vi',
        ...(connectionId ? { connectionId } : {}),
      })
      setCandidates(result.candidates)
      setAdded([])
      // Ứng viên mới thì ảnh minh hoạ cũ không còn dùng được.
      setIllustrations({})
    } catch (cause) {
      setError(errorMessage(cause))
      setCandidates([])
      setIllustrations({})
    } finally {
      setBusy(false)
    }
  }

  async function add(candidate: GeneratedCharacter) {
    setBusy(true)
    setError('')

    try {
      const created = (await characterApi.create(candidate)).character
      setAdded((current) => [...current, candidate.name])

      // Có ảnh minh hoạ thì gắn luôn làm ảnh tham chiếu. Lỗi gắn ảnh không làm
      // mất nhân vật vừa tạo — người dùng vẫn thêm ảnh lại được ở thẻ nhân vật.
      const illustration = illustrations[candidate.name]
      let attachError = ''
      if (illustration) {
        try {
          await characterApi.attachReferenceFromGeneration(created.id, illustration.generationId)
        } catch (cause) {
          attachError = errorMessage(cause)
        }
      }

      // Tải lại thư viện SAU khi gắn ảnh để thẻ hiển thị ảnh tham chiếu mới.
      onAdded(created.name)

      if (illustration && !attachError) {
        onNotify(`Đã thêm nhân vật "${created.name}" kèm ảnh tham chiếu.`)
      } else if (attachError) {
        onNotify(`Đã thêm nhân vật "${created.name}", nhưng chưa gắn được ảnh: ${attachError}`)
      } else {
        onNotify(`Đã thêm nhân vật "${created.name}" vào thư viện.`)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="modal-card character-ai-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI tạo nhân vật"
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" /> AI character</div>
            <h2>AI tạo nhân vật</h2>
          </div>
          <button className="close-button" disabled={busy} onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        <p className="modal-description">
          Mô tả nhân vật bạn muốn, AI sẽ gợi ý vài nhân vật mẫu. Bạn có thể tạo ảnh minh hoạ cho
          từng nhân vật rồi thêm vào thư viện — ảnh đó trở thành ảnh tham chiếu của nhân vật.
        </p>

        {!hasConnection ? (
          <div className="character-ai-empty">
            <BrainCircuit size={22} />
            <strong>Chưa có kết nối LLM</strong>
            <span>
              Cần một kết nối LLM (Base URL + API key) để AI tạo nhân vật. Thêm trong API &amp;
              Models trước.
            </span>
            <button className="primary-small-button" onClick={onOpenSettings}>
              Mở API &amp; Models
            </button>
          </div>
        ) : (
          <>
            <div className="modal-form">
              <label>
                Mô tả nhân vật
                <textarea
                  value={description}
                  placeholder="Ví dụ: một phi hành gia trẻ, điềm tĩnh, người Việt, mặc đồ bay màu xanh"
                  maxLength={2000}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>

              <div className="character-ai-controls">
                <label>
                  Số lượng
                  <div className="select-wrap">
                    <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                      {COUNT_OPTIONS.map((value) => (
                        <option key={value} value={value}>{value} nhân vật</option>
                      ))}
                    </select>
                  </div>
                </label>
                {connections.length > 1 && (
                  <label>
                    Kết nối LLM
                    <div className="select-wrap">
                      <select
                        value={connectionId}
                        onChange={(event) => setConnectionId(event.target.value)}
                      >
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name} · {connection.modelId}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                )}
              </div>

              <button
                type="button"
                className="secondary-button character-ai-generate"
                disabled={!canGenerate}
                onClick={() => void generate()}
              >
                {busy
                  ? <LoaderCircle size={15} className="spin" />
                  : <Sparkles size={15} />} Tạo bằng AI
              </button>

              {error && <div className="form-error" role="alert">{error}</div>}
            </div>

            {candidates.length > 0 && (
              <div className="character-ai-results">
                <div className="character-ai-results-heading">
                  <span>{candidates.length} nhân vật mẫu</span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void generate()}
                  >
                    <RefreshCw size={13} /> Tạo lại
                  </button>
                </div>
                <div className="character-ai-grid">
                  {candidates.map((candidate) => {
                    const isAdded = added.includes(candidate.name)
                    return (
                      <article className="character-ai-card" key={candidate.name}>
                        <div className="character-ai-card-head">
                          <div className="project-character-avatar">
                            {candidate.name.slice(0, 1).toUpperCase()}
                          </div>
                          <h3>{candidate.name}</h3>
                        </div>
                        <p>{candidate.appearance || 'Chưa mô tả ngoại hình.'}</p>
                        <div className="character-library-tags">
                          {VOICE_LABELS.filter(({ key }) => candidate.voice[key]).map(({ key, label }) => (
                            <span key={key}>{label}: {candidate.voice[key]}</span>
                          ))}
                        </div>
                        <IllustrationPanel
                          character={candidate}
                          models={models}
                          initial={illustrations[candidate.name] ?? null}
                          onReady={(state) =>
                            setIllustrations((current) => ({ ...current, [candidate.name]: state }))
                          }
                        />
                        <button
                          type="button"
                          className={isAdded ? 'secondary-button' : 'primary-small-button'}
                          disabled={busy || isAdded}
                          onClick={() => void add(candidate)}
                        >
                          {isAdded ? 'Đã thêm' : <><Plus size={14} /> Thêm vào danh sách</>}
                        </button>
                      </article>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  )
}
