import type { Metadata } from 'next'
import { Checkout } from '@/components/shop/checkout'

export const metadata: Metadata = { title: 'Checkout' }

export default async function ShopCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <Checkout id={id} />
}
