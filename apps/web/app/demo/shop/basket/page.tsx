import type { Metadata } from 'next'
import { BasketPage } from '@/components/shop/basket-page'

export const metadata: Metadata = { title: 'Basket' }

export default function ShopBasketPage() {
  return <BasketPage />
}
