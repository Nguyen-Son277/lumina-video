import { useEffect, type DependencyList, type RefObject } from 'react'

/** Preserve each chat surface's explicit scroll triggers rather than observing arbitrary DOM changes. */
export function useScrollToBottom(ref: RefObject<HTMLElement | null>, dependencies: DependencyList) {
  useEffect(() => {
    const element = ref.current
    if (element) element.scrollTop = element.scrollHeight
  }, [ref, ...dependencies])
}
