import type { Metadata } from 'next'
import { TopupScreen } from '@/components/topup/topup-screen'

export const metadata: Metadata = { title: 'Top up' }

export default function TopupPage() {
  return <TopupScreen />
}
