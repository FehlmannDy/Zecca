import type { Metadata } from 'next'
import { SendScreen } from '@/components/send/send-screen'

export const metadata: Metadata = { title: 'Send' }

export default function SendPage() {
  return <SendScreen />
}
