// Feature gating and the approve button's words (UI.md §5.4): "Approve with Face ID" on a phone that has it and
// has it enrolled, with FEATURE_PASSKEY on; otherwise "Approve". Never promise Face ID when the flag is off.

type ConfigLike = { signerMode: string; features: Partial<Record<string, boolean>> } | null | undefined

export function passkeyFeatureOn(config: ConfigLike): boolean {
  return !!config && config.signerMode === 'privy' && config.features.passkey === true
}

type WindowLike = { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } } | undefined

/** True when this device has a built-in authenticator that verifies the user (Face ID, Touch ID, fingerprint). */
export async function isPasskeyAvailable(win: WindowLike = typeof window !== 'undefined' ? (window as WindowLike) : undefined): Promise<boolean> {
  try {
    const check = win?.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable
    return typeof check === 'function' ? (await check.call(win!.PublicKeyCredential)) === true : false
  } catch {
    return false
  }
}

export type BiometricWord = 'Face ID' | 'fingerprint'

export function biometricWord(userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): BiometricWord {
  return /Android/i.test(userAgent) ? 'fingerprint' : 'Face ID'
}

export function approveLabel(s: { featureOn: boolean; available: boolean; enrolled: boolean; word: BiometricWord }): string {
  return s.featureOn && s.available && s.enrolled ? `Approve with ${s.word}` : 'Approve'
}
