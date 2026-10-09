import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Image as ImageIcon, LoaderCircle, Trash2, X } from 'lucide-react'
import { errorMessage, storedErrorMessage } from '../api/client'
import type { CharacterInput, CharacterVoice, ProjectCharacter } from '../api/projectTypes'
import { formatBytes, translate, useTranslation, type MessageParams } from '../i18n'
import { charactersCatalog, type CharactersCatalog } from '../i18n/catalogs/characters'

/** Khoá hợp lệ của catalog namespace `characters`. */
export type CharactersCatalogKey = keyof CharactersCatalog & string

/**
 * Trường lỗi có cấu trúc do backend lưu kèm (generation, dự án…).
 *
 * Tiêu đề được dịch lại theo ngôn ngữ hiện tại; `errorMessage` là văn bản gốc của
 * provider/nhà cung cấp nên KHÔNG dịch máy, chỉ dùng làm chi tiết gốc.
 */
export type StoredErrorFields = {
  errorCode?: string | null
  errorMessage?: string | null
  errorMessageKey?: string | null
  errorMessageParams?: Record<string, string | number> | null
}

/** Lỗi do giao diện tự sinh: chỉ giữ khoá catalog, câu chữ tra lúc render. */
export class CharactersLocalError extends Error {
  constructor(readonly key: CharactersCatalogKey, readonly params?: MessageParams) {
    super(key)
    this.name = 'CharactersLocalError'
  }
}

/** Lỗi có cấu trúc từ backend: dịch tiêu đề, giữ nguyên văn thô làm chi tiết. */
export class CharactersStoredError extends Error {
  constructor(
    readonly fields: StoredErrorFields,
    /** Khoá dự phòng khi backend không kèm mã/khoá lỗi nào. */
    readonly fallbackKey?: CharactersCatalogKey,
  ) {
    super(fields.errorMessageKey ?? fields.errorCode ?? 'stored-error')
    this.name = 'CharactersStoredError'
  }
}

/**
 * Lỗi hiển thị trên giao diện.
 *
 * Luôn giữ descriptor (Error gốc hoặc khoá catalog) thay vì câu chữ đã dịch, nhờ
 * đó đổi ngôn ngữ là lỗi đang hiện cũng đổi theo mà không cần chạy lại tác vụ.
 */
export type CharactersUiError =
  | { kind: 'cause'; cause: unknown }
  | { kind: 'local'; key: CharactersCatalogKey; params?: MessageParams }
  | { kind: 'stored'; fields: StoredErrorFields; fallbackKey?: CharactersCatalogKey }

/** Lỗi giao diện tự sinh, dựng sẵn descriptor để lưu vào state. */
export function localCharactersError(
  key: CharactersCatalogKey,
  params?: MessageParams,
): CharactersUiError {
  return { kind: 'local', key, params }
}

/** Chuẩn hoá lỗi bắt được thành descriptor; lỗi API/AI giữ nguyên Error gốc. */
export function describeCharactersError(cause: unknown): CharactersUiError {
  if (cause instanceof CharactersLocalError) {
    return { kind: 'local', key: cause.key, params: cause.params }
  }
  if (cause instanceof CharactersStoredError) {
    return { kind: 'stored', fields: cause.fields, fallbackKey: cause.fallbackKey }
  }
  return { kind: 'cause', cause }
}

/** Thông báo lỗi theo ngôn ngữ hiện tại; gọi trong lúc render. */
export function charactersErrorMessage(error: CharactersUiError | null | undefined): string {
  if (!error) return ''
  if (error.kind === 'local') return translate(charactersCatalog, error.key, error.params)
  if (error.kind === 'stored') {
    return (
      storedErrorMessage(error.fields) ||
      (error.fallbackKey ? translate(charactersCatalog, error.fallbackKey) : '')
    )
  }
  return errorMessage(error.cause)
}

/**
 * Chi tiết gốc của lỗi để hiện trong tooltip: văn bản provider/AI/server giữ nguyên
 * văn, không dịch máy. Lỗi giao diện tự sinh không có chi tiết gốc.
 */
export function charactersErrorDetail(error: CharactersUiError | null | undefined): string {
  if (!error) return ''
  if (error.kind === 'stored') return error.fields.errorMessage ?? ''
  if (error.kind === 'cause') return error.cause instanceof Error ? error.cause.message : ''
  return ''
}

const VOICE_FIELDS: Array<keyof CharacterVoice> = [
  'language', 'accent', 'pitch', 'timbre', 'pace', 'articulation', 'habits',
]

/** Khoá catalog cho nhãn từng trường giọng nói (tra lúc render, không đóng băng ngôn ngữ). */
const VOICE_LABEL_KEYS = {
  language: 'voiceFieldLanguage',
  accent: 'voiceFieldAccent',
  pitch: 'voiceFieldPitch',
  timbre: 'voiceFieldTimbre',
  pace: 'voiceFieldPace',
  articulation: 'voiceFieldArticulation',
  habits: 'voiceFieldHabits',
} as const satisfies Record<keyof CharacterVoice, keyof typeof charactersCatalog>

/** Khoá catalog cho gợi ý (placeholder) của từng trường giọng nói. */
const VOICE_PLACEHOLDER_KEYS = {
  language: 'voicePlaceholderLanguage',
  accent: 'voicePlaceholderAccent',
  pitch: 'voicePlaceholderPitch',
  timbre: 'voicePlaceholderTimbre',
  pace: 'voicePlaceholderPace',
  articulation: 'voicePlaceholderArticulation',
  habits: 'voicePlaceholderHabits',
} as const satisfies Record<keyof CharacterVoice, keyof typeof charactersCatalog>

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
  const { t } = useTranslation(charactersCatalog)
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
          <button className="close-button" disabled={busy} onClick={onClose} aria-label={t('close')}>
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
  const { t } = useTranslation(charactersCatalog)
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
  // Giữ descriptor lỗi (không phải câu đã dịch) để đổi ngôn ngữ không đóng băng câu lỗi.
  const [error, setError] = useState<CharactersUiError | null>(null)
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
    setError(null)
    try {
      await onSave(draft, {
        ...(file ? { file } : {}),
        ...(removeReference ? { removeReference: true } : {}),
        ...(!character && allowLibraryScope ? { scope } : {}),
      })
      onClose()
    } catch (cause) {
      setError(describeCharactersError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={character ? t('formTitleEdit') : t('formTitleNew')}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <fieldset className="modal-form project-fields" disabled={busy}>
          <div className="project-character-form-grid">
            <section className="project-form-section">
              <h3>{t('formSectionCharacter')}</h3>
              {!character && allowLibraryScope && (
                <Field label={t('formScopeLabel')}>
                  <select
                    value={scope}
                    onChange={(event) => setScope(event.target.value as CharacterScope)}
                  >
                    <option value="library">{t('formScopeLibrary')}</option>
                    <option value="project">{t('formScopeProject')}</option>
                  </select>
                </Field>
              )}
              <Field label={t('formNameLabel')}>
                <input
                  required
                  value={draft.name}
                  placeholder={t('formNamePlaceholder')}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label={t('formAppearanceLabel')}>
                <textarea
                  value={draft.appearance}
                  placeholder={t('formAppearancePlaceholder')}
                  onChange={(event) => setDraft({ ...draft, appearance: event.target.value })}
                />
              </Field>

              <div className="project-reference">
                <span className="project-reference-label">{t('formReferenceLabel')}</span>
                <div className="project-reference-body">
                  <div className="project-reference-preview">
                    {preview ? (
                      <img
                        src={preview}
                        alt={t('referenceImageAlt', { name: draft.name || t('genericCharacter') })}
                      />
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
                      {preview ? t('formChooseAnotherImage') : t('formChooseImage')}
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
                        <Trash2 size={14} /> {t('formRemoveImage')}
                      </button>
                    )}
                    <span className="project-hint">
                      {t('formReferenceHint', {
                        size: formatBytes(5 * 1024 * 1024, { decimals: 0 }),
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <section className="project-form-section">
              <h3>{t('formSectionVoice')}</h3>
              <div className="project-voice-grid">
                {VOICE_FIELDS.map((field) => (
                  <Field key={field} label={t(VOICE_LABEL_KEYS[field])}>
                    <input
                      value={draft.voice[field]}
                      placeholder={t(VOICE_PLACEHOLDER_KEYS[field])}
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

          <Notice tone="warn">{t('formVoiceNotice')}</Notice>
        </fieldset>
        {error && <div className="form-error" role="alert" title={charactersErrorDetail(error)}>{charactersErrorMessage(error)}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary-small-button" disabled={busy || !draft.name.trim()}>
            {busy && <LoaderCircle size={14} className="spin" />} {t('saveCharacter')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
