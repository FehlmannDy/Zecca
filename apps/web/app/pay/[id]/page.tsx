import type { Metadata } from 'next'
import { PayRequestPreview } from '@/components/zecca/pay-preview'

export const metadata: Metadata = { title: 'Pay' }

// Placeholder until agent G builds the pay page (UI.md §5.5). It already shows the request, even logged out.
export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <PayRequestPreview id={id} />
}
