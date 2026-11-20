// Which part of /merchant to show. The first choice waits for the stored session. After that, a finished sign-up
// only hands over when the flow says so (its "You're set" screen stays up), but a session that ends (sign-out, or a
// 401 from an expired or forgotten session) always goes back to the sign-up.
export type SpaceMode = 'unknown' | 'signup' | 'space'

export function nextSpaceMode(mode: SpaceMode, hydrated: boolean, signedUp: boolean): SpaceMode {
  if (!hydrated) return mode
  if (mode === 'unknown') return signedUp ? 'space' : 'signup'
  if (mode === 'space' && !signedUp) return 'signup'
  return mode
}
