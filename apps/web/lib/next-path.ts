/** ?next=/pay/abc brings people back to where they started; only same-origin paths, else /app. */
export function safeNextPath(n: string | null): string {
  return n && /^\/[a-zA-Z0-9]/.test(n) && !/[\\:]/.test(n) ? n : '/app'
}
