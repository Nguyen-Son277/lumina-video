import { useRef } from 'react'

/** Block duplicate same-tick submits until React applies the caller's busy state. */
export function useSubmitGuard(busy: boolean) {
  const submitted = useRef(false)
  return () => {
    if (busy || submitted.current) return false
    submitted.current = true
    // Only bridge the current event turn: failed/no-op callbacks remain retryable.
    queueMicrotask(() => { submitted.current = false })
    return true
  }
}
