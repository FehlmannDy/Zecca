import type { Metadata } from 'next'
import { IdentityScreen } from '@/components/identity/identity-screen'

export const metadata: Metadata = { title: 'Verify your identity' }

export default function IdentityPage() {
  return <IdentityScreen />
}
