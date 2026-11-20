// Starts the mock API in the browser (NEXT_PUBLIC_API_MOCK=1). State persists in localStorage across reloads;
// `window.__zeccaMock.reset()` in the console starts over.
import { setupWorker } from 'msw/browser'
import { createHandlers } from './handlers'
import { createMockState } from './state'

export async function startMockWorker(apiOrigin: string) {
  const state = createMockState({ storage: window.localStorage, config: { webOrigin: window.location.origin } })
  const worker = setupWorker(...createHandlers(state, apiOrigin))
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true, serviceWorker: { url: '/mockServiceWorker.js' } })
  ;(window as unknown as { __zeccaMock: typeof state }).__zeccaMock = state
  return state
}
