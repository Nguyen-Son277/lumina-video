import { useEffect, type RefObject } from 'react'

/** Size to content plus borders; CSS retains ownership of max-height and overflow. */
export function useTextareaAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight + (element.offsetHeight - element.clientHeight)}px`
  }, [ref, value])
}
