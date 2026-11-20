import type { Metadata } from 'next'
import { PayScreen } from '@/components/merchant/pay-screen'

export const metadata: Metadata = { title: 'Pay' }

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <PayScreen id={id} />
}
