import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Send, Sparkles } from 'lucide-react'
import type { PlanMessage } from '../../api/planner'

/**
 * Khung chat với Trợ lý AI.
 *
 * Log tin nhắn cuộn dọc và tự cuộn xuống tin mới nhất; ô nhập nhiều dòng, Enter
 * gửi còn Shift+Enter xuống dòng.
 */
export function PlannerChat({
  messages,
  busy,
  disabled,
  onSend,
}: {
  messages: PlanMessage[]
  busy: boolean
  /** Khoá khi chưa có kết nối LLM hoặc phiên chưa sẵn sàng. */
  disabled?: boolean
  onSend: (content: string) => void
}) {
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  // Cuộn xuống cuối mỗi khi có tin nhắn mới hoặc đang chờ phản hồi.
  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, busy])

  const canSend = !busy && !disabled && draft.trim().length > 0

  function submit() {
    if (!canSend) return
    onSend(draft.trim())
    setDraft('')
  }

  return (
    <div className="planner-chat">
      <div className="planner-log" ref={logRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="planner-empty">
            <Sparkles size={20} />
            <strong>Mô tả video bạn muốn làm</strong>
            <span>
              Ví dụ: “Video 60 giây về một chuyến đi của hai người bạn, tông ấm áp, có lời
              thoại tiếng Việt.” AI sẽ hỏi lại rồi tổng hợp thành đề xuất.
            </span>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`planner-bubble ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}
            >
              <div className="planner-bubble-role">
                {message.role === 'user' ? 'Bạn' : 'Trợ lý AI'}
              </div>
              <div className="planner-bubble-body">{message.content}</div>
            </div>
          ))
        )}

        {busy && (
          <div className="planner-bubble is-assistant">
            <div className="planner-bubble-role">Trợ lý AI</div>
            <div className="planner-bubble-body planner-thinking">
              <LoaderCircle size={14} className="spin" /> Đang soạn…
            </div>
          </div>
        )}
      </div>

      <div className="planner-composer">
        <textarea
          value={draft}
          disabled={busy || disabled}
          maxLength={8000}
          placeholder="Nhập nội dung… (Enter để gửi, Shift+Enter để xuống dòng)"
          onChange={(event) => setDraft(event.target.value)}
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
          disabled={!canSend}
          onClick={submit}
        >
          {busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />} Gửi
        </button>
      </div>
    </div>
  )
}
