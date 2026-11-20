import type { Metadata } from 'next'
import { DevPasskey } from '@/components/passkey/dev-passkey'

export const metadata: Metadata = { title: 'Passkey test', robots: { index: false } }

export default function DevPasskeyPage() {
  return <DevPasskey />
}
