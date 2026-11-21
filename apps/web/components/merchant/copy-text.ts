// Copy a pay link so the merchant can paste it into NFC PayLink by hand (the fallback when the app handoff fails).
type ClipboardLike = { writeText(text: string): Promise<void> } | null | undefined
type CopyEnv = { clipboard?: ClipboardLike; legacyCopy?: (text: string) => boolean }

/** Hidden textarea + execCommand('copy'): works on http pages and older browsers where the async clipboard does not. */
function legacyCopyDefault(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand('copy')
  } finally {
    ta.remove()
  }
}

/** 'copied' when some way worked; 'manual' when nothing could copy (the caller then shows the text selected). */
export async function copyText(text: string, env: CopyEnv = {}): Promise<'copied' | 'manual'> {
  const clipboard = 'clipboard' in env ? env.clipboard : typeof navigator !== 'undefined' ? navigator.clipboard : null
  const legacy = env.legacyCopy ?? legacyCopyDefault
  if (clipboard) {
    try {
      await clipboard.writeText(text)
      return 'copied'
    } catch {
      /* fall through to the legacy copy */
    }
  }
  try {
    return legacy(text) ? 'copied' : 'manual'
  } catch {
    return 'manual'
  }
}
