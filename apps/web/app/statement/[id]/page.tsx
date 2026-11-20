import type { Metadata } from 'next'
import { StatementView } from '@/components/proofs/statement-view'

export const metadata: Metadata = { title: 'Statement', robots: { index: false } }

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <StatementView id={id} />
}
