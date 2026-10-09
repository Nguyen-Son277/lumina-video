import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, Send, Sparkles, Wand2 } from 'lucide-react'
import type { PlanMessage, PlanSession, PlanTarget } from '../../api/planner'

const TARGET_LABELS: Record<PlanTarget, string> = {
  script: 'Kịch bản nháp',
  cast: 'Nhân vật',
  timeline: 'Timeline',
}

/** Chip hành động nhanh: gọi thẳng bước tương ứng thay vì chờ AI đoán. */
const QUICK_ACTIONS: Array<{ target: PlanTarget; label: string; icon: typeof Sparkles }> = [
  { target: 'script', label: 'Viết kịch bản', icon: Wand2 },
  { target: 'cast', label: 'Đề xuất nhân vật', icon: Sparkles },
  { target: 'timeline', label: 'Lên timeline', icon: Check },
]

/**
 * Khung chat chính của Tạo kịch bản AI.
 *
 * Chat là bề mặt mặc định và lớn nhất: người dùng nhắn trực tiếp, AI trả lời kèm
 * cập nhật artifact của mục đang chọn. Chip hành động nhanh chạy đúng bước khi
 * người dùng muốn chắc chắn, không phụ thuộc vào việc AI đoán ý.
 */
export function PlanChat({
  session,
  messages,
  busy,
  active,
  onSend,
  onQuickAction,
}: {
  session: PlanSession
  messages: PlanMessage[]
  busy: string
  /** Mục mà chat đang sửa. */
  active: PlanTarget
  onSend: (content: string) => void
  onQuickAction: (target: PlanTarget) => void
}) {
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const chatBusy = busy.startsWith('chat:')

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, busy])

  // Ô nhập cao theo nội dung để đọc lại đoạn dài; trần 30% chiều cao màn hình do
  // CSS (`max-height: 30dvh`) lo, quá trần thì ô tự cuộn bên trong.
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    // scrollHeight không gồm border → cộng phần chênh để ô vừa khít, không nhấp nháy thanh cuộn.
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
  }, [draft])

  function submit(): void {
    const content = draft.trim()
    if (!content || busy) return
    onSend(content)
    setDraft('')
  }

  return (
    <div className="plan-chat">
      <div className="plan-chat-head">
        <div>
          <strong>Chat với AI</strong>
          <span>
            Đang sửa: <em>{TARGET_LABELS[active]}</em>
            {session.cast.length > 0 && <> · {session.cast.length} nhân vật</>}
            {session.timeline?.frames.length ? <> · {session.timeline.frames.length} frame</> : null}
          </span>
        </div>
      </div>

      <div className="plan-chat-chips" role="group" aria-label="Hành động nhanh">
        {QUICK_ACTIONS.map(({ target, label, icon: Icon }) => {
          const running = busy === `quick:${target}`
          // Nhân vật và timeline cần kịch bản nháp làm đầu vào.
          const disabled = busy !== '' || (target !== 'script' && !session.script)
          return (
            <button
              key={target}
              type="button"
              className="plan-chip"
              disabled={disabled}
              title={
                target !== 'script' && !session.script
                  ? 'Cần viết kịch bản trước'
                  : `Gọi AI: ${label}`
              }
              onClick={() => onQuickAction(target)}
            >
              {running ? <LoaderCircle size={14} className="spin" /> : <Icon size={14} />} {label}
            </button>
          )
        })}
      </div>

      <div className="plan-chat-log" ref={logRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="planner-empty">
            <Sparkles size={20} />
            <strong>Mô tả video bạn muốn làm</strong>
            <span>
              Ví dụ: “Video 60 giây về một chuyến đi của hai người bạn, tông ấm áp, có lời thoại
              tiếng Việt.” AI sẽ hỏi lại, viết kịch bản nháp và có thể tự chạy bước tiếp theo.
            </span>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`planner-bubble ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}
            >
              <div className="planner-bubble-role">
                {message.role === 'user' ? 'Bạn' : 'Kịch bản AI'}
              </div>
              <div className="planner-bubble-body">{message.content}</div>
            </div>
          ))
        )}

        {chatBusy && (
          <div className="planner-bubble is-assistant">
            <div className="planner-bubble-role">Kịch bản AI</div>
            <div className="planner-bubble-body planner-thinking">
              <LoaderCircle size={14} className="spin" /> Đang soạn…
            </div>
          </div>
        )}
      </div>

      <div className="planner-composer">
        <textarea
          ref={composerRef}
          value={draft}
          disabled={busy !== ''}
          maxLength={8000}
          aria-label="Nội dung tin nhắn"
          placeholder={`Nhắn cho AI để sửa ${TARGET_LABELS[active].toLowerCase()}… (Enter để gửi, Shift+Enter để xuống dòng)`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button type="button" className="generate-button" disabled={busy !== '' || !draft.trim()} onClick={submit}>
          {chatBusy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />} Gửi
        </button>
      </div>
    </div>
  )
}
