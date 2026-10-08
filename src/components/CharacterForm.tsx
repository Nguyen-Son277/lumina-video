import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Image as ImageIcon, LoaderCircle, Trash2, X } from 'lucide-react'
import { errorMessage } from '../api/client'
import type { CharacterInput, CharacterVoice, ProjectCharacter } from '../api/projectTypes'

const VOICE_FIELDS: Array<keyof CharacterVoice> = [
  'language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits',
]

const VOICE_LABELS: Record<keyof CharacterVoice, string> = {
  language: 'Ngôn ngữ',
  accent: 'Giọng vùng miền',
  pitch: 'Cao độ',
  timbre: 'Âm sắc',
  pace: 'Tốc độ',
  articulation: 'Phát âm',
  habits: 'Thói quen nói',
}

const VOICE_PLACEHOLDERS: Record<keyof CharacterVoice, string> = {
  language: 'vi',
  accent: 'Miền Bắc',
  pitch: 'Trung trầm',
  timbre: 'Ấm, hơi khàn',
  pace: 'Vừa phải',
  articulation: 'Rõ ràng, không nuốt chữ',
  habits: 'Ngắt nghỉ nhẹ cuối câu',
}

/** Phạm vi của nhân vật: dùng chung toàn tài khoản hay chỉ trong dự án. */
export type CharacterScope = 'library' | 'project'

export function Modal({
  title,
  children,
  onClose,
  busy,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  busy: boolean
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="modal-card project-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="close-button" disabled={busy} onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return <p className={tone === 'warn' ? 'project-cost-warning' : 'project-hint'}>{children}</p>
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  )
}

/** Nhân vật có ảnh tham chiếu hay không, dùng cho thông báo trong form. */
export function hasReference(character?: ProjectCharacter): boolean {
  return Boolean(character?.referenceUrl)
}

/**
 * Form tạo/sửa nhân vật, dùng chung cho thư viện nhân vật và Studio dự án.
 *
 * Hồ sơ giọng nói và ảnh tham chiếu được quản lý ở cùng một chỗ để hai luồng
 * luôn có cùng dữ liệu. Khi tạo mới trong Studio, người dùng chọn phạm vi: dùng
 * chung cho mọi dự án hay chỉ thuộc dự án hiện tại.
 */
export function CharacterForm({
  character,
  language,
  allowLibraryScope = false,
  onSave,
  onClose,
}: {
  character?: ProjectCharacter
  language: string
  /** Hiện lựa chọn phạm vi khi tạo mới (chỉ dùng trong Studio). */
  allowLibraryScope?: boolean
  onSave: (
    input: CharacterInput,
    changes: { file?: File; removeReference?: boolean; scope?: CharacterScope },
  ) => Promise<void>
  onClose: () => void
}) {
  const emptyVoice: CharacterVoice = {
    language,
    accent: '',
    pitch: '',
    timbre: '',
    pace: '',
    articulation: '',
    habits: '',
  }
  const [draft, setDraft] = useState<CharacterInput>(
    character
      ? {
          name: character.name,
          appearance: character.appearance,
          voice: { ...emptyVoice, ...character.voice },
        }
      : { name: '', appearance: '', voice: emptyVoice },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Mặc định dùng chung: nhân vật tạo trong Studio vẫn dùng lại được ở nơi khác.
  // Khi sửa, giữ nguyên phạm vi hiện có của nhân vật.
  const [scope, setScope] = useState<CharacterScope>(
    character && character.projectId !== null ? 'project' : 'library',
  )

  const [file, setFile] = useState<File | null>(null)
  const [removeReference, setRemoveReference] = useState(false)
  const [localPreview, setLocalPreview] = useState('')

  // Thu hồi blob URL khi đổi tệp hoặc đóng form để không rò rỉ bộ nhớ.
  useEffect(() => {
    if (!file) {
      setLocalPreview('')
      return
    }
    const url = URL.createObjectURL(file)
    setLocalPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const existingReference = character?.referenceUrl && !removeReference ? character.referenceUrl : ''
  const preview = localPreview || existingReference

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSave(draft, {
        ...(file ? { file } : {}),
        ...(removeReference ? { removeReference: true } : {}),
        ...(!character && allowLibraryScope ? { scope } : {}),
      })
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={character ? 'Sửa nhân vật / giọng nói' : 'Thêm nhân vật'}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <fieldset className="modal-form project-fields" disabled={busy}>
          <div className="project-character-form-grid">
            <section className="project-form-section">
              <h3>Nhân vật</h3>
              {!character && allowLibraryScope && (
                <Field label="Phạm vi sử dụng">
                  <select
                    value={scope}
                    onChange={(event) => setScope(event.target.value as CharacterScope)}
                  >
                    <option value="library">Dùng chung (Thư viện) — mọi dự án</option>
                    <option value="project">Chỉ dự án này</option>
                  </select>
                </Field>
              )}
              <Field label="Tên">
                <input
                  required
                  value={draft.name}
                  placeholder="An"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="Ngoại hình">
                <textarea
                  value={draft.appearance}
                  placeholder="Áo xanh, tóc ngắn, dáng thư sinh…"
                  onChange={(event) => setDraft({ ...draft, appearance: event.target.value })}
                />
              </Field>

              <div className="project-reference">
                <span className="project-reference-label">Ảnh tham chiếu nhân vật</span>
                <div className="project-reference-body">
                  <div className="project-reference-preview">
                    {preview ? (
                      <img src={preview} alt={`Ảnh tham chiếu của ${draft.name || 'nhân vật'}`} />
                    ) : (
                      <ImageIcon size={22} />
                    )}
                  </div>
                  <div className="project-reference-controls">
                    <label className="project-file-button">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(event) => {
                          setFile(event.target.files?.[0] ?? null)
                          setRemoveReference(false)
                        }}
                      />
                      {preview ? 'Chọn ảnh khác' : 'Chọn ảnh'}
                    </label>
                    {preview && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setFile(null)
                          setRemoveReference(true)
                        }}
                      >
                        <Trash2 size={14} /> Xóa ảnh
                      </button>
                    )}
                    <span className="project-hint">
                      PNG, JPEG, WebP hoặc GIF, tối đa 5 MB. Ảnh được lưu riêng tư và gửi kèm khi
                      tạo ảnh hoặc video để model bám đúng ngoại hình.
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <section className="project-form-section">
              <h3>Hồ sơ giọng nói</h3>
              <div className="project-voice-grid">
                {VOICE_FIELDS.map((field) => (
                  <Field key={field} label={VOICE_LABELS[field]}>
                    <input
                      value={draft.voice[field]}
                      placeholder={VOICE_PLACEHOLDERS[field]}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          voice: { ...draft.voice, [field]: event.target.value },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            </section>
          </div>

          <Notice tone="warn">
            Giọng nói chỉ là mô tả trong prompt, dùng chung cho mọi cảnh của nhân vật này. Ứng dụng
            không dùng dịch vụ giọng nói bên thứ ba và không bảo đảm giọng giống tuyệt đối.
          </Notice>
        </fieldset>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Hủy
          </button>
          <button className="primary-small-button" disabled={busy || !draft.name.trim()}>
            {busy && <LoaderCircle size={14} className="spin" />} Lưu nhân vật
          </button>
        </div>
      </form>
    </Modal>
  )
}
