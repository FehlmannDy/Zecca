import { useSyncExternalStore } from 'react'

/** Live media query match; false during server rendering. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined') return () => {}
      const m = window.matchMedia(query)
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
    () => false,
  )
}

export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)')
/** Tablet landscape and up: the glass workspace and the Peak Chart. */
export const useWide = () => useMediaQuery('(min-width: 1024px)')
