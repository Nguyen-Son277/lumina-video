/** Shared by API/history and UI: artifacts are data, never assistant chat copy. */
export const PLANNER_CHAT_FALLBACK = 'Mình chưa nhận được lời giải thích dễ đọc từ AI. Bạn hãy nói rõ ý tưởng hoặc điều muốn bổ sung; mình sẽ cùng bạn tổng hợp trước khi tạo kịch bản.'

export function plannerChatText(content: string, fallback: string): string {
  function readable(input: string, depth: number): string {
    if (depth > 4) return ''
    const text = input.trim()
    if (!text) return ''

    // Handle fences independently so prose before/after them is preserved.
    if (text.includes('```')) {
      const withoutFences = text.replace(/```[^\n`]*\n([\s\S]*?)(?:```|$)/g,
        (_block, body: string) => readable(body, depth + 1))
      if (withoutFences !== text) return readable(withoutFences, depth + 1)
    }

    function envelope(raw: string): string {
      try {
        const value: unknown = JSON.parse(raw)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
        const record = value as Record<string, unknown>
        const parts = ['reply', 'summary']
          .map(key => typeof record[key] === 'string' ? readable(record[key] as string, depth + 1) : '')
          .filter(Boolean)
        return [...new Set(parts)].join('\n\n')
      } catch { return '' }
    }

    // Recognize technical JSON, not ordinary prose such as “{ý tưởng}” or “[ghi chú]”.
    const startPattern = /\{\s*(?:"|\})|\[\s*(?:\{|\[|"|\]|-?\d|true\b|false\b|null\b)/g
    const parts: string[] = []
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = startPattern.exec(text))) {
      const start = match.index
      if (start < cursor) continue
      const stack: string[] = []
      let quoted = false
      let escaped = false
      let end = -1
      for (let i = start; i < text.length; i++) {
        const char = text[i]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
          continue
        }
        if (char === '"') quoted = true
        else if (char === '{' || char === '[') stack.push(char)
        else if (char === '}' || char === ']') {
          const opening = stack.pop()
          if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) break
          if (!stack.length) { end = i + 1; break }
        }
      }
      parts.push(text.slice(cursor, start))
      // A truncated technical payload is not suitable for display either.
      if (end < 0) { cursor = text.length; break }
      parts.push(envelope(text.slice(start, end)))
      cursor = end
      startPattern.lastIndex = end
    }
    parts.push(text.slice(cursor))
    return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
  }
  return readable(content, 0) || fallback
}
