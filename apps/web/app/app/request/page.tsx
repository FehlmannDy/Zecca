import type { Metadata } from 'next'
import { RequestScreen } from '@/components/send/request-screen'

export const metadata: Metadata = { title: 'Get paid' }

export default function RequestPage() {
  return <RequestScreen />
}
