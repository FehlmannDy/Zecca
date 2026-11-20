// The "get paid" link (UI.md §5.4, /app/request): WEB_ORIGIN/app/send?to=<handle>, and reading it back on /app/send.

export function requestLink(webOrigin: string, handle: string): string {
  const u = new URL('/app/send', webOrigin)
  u.searchParams.set('to', handle)
  return u.toString()
}

/** The recipient from /app/send?to=..., without a leading "@"; null when there is none. */
export function sendToParam(search: string): string | null {
  const to = new URLSearchParams(search).get('to')?.trim().replace(/^@/, '')
  return to ? to : null
}
