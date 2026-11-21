import type { Metadata } from 'next'
import { HowItWorks } from '@/components/landing/how-it-works'

export const metadata: Metadata = {
  title: 'How it works',
  description: 'Which network each step runs on, how the Zecca pool hides amounts, and the transactions on the public ledger.',
}

export default function HowItWorksPage() {
  return <HowItWorks />
}
