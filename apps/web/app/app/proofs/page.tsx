import type { Metadata } from 'next'
import { ProofsScreen } from '@/components/proofs/proofs-screen'

export const metadata: Metadata = { title: 'Statements' }

export default function ProofsPage() {
  return <ProofsScreen />
}
