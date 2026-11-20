import type { Metadata } from 'next'
import { SignupGate } from '@/components/zecca/signup-gate'

export const metadata: Metadata = { title: 'Sign up' }

export default function SignupPage() {
  return <SignupGate />
}
