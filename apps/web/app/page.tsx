import type { Metadata } from 'next'
import { Landing } from '@/components/landing/landing'

export const metadata: Metadata = {
  title: { absolute: 'Zecca · Money that moves like a message' },
  description: 'Sign in with an email. Pay with a tap. Your balance stays between you and the people you pay.',
}

export default function Home() {
  return <Landing />
}
