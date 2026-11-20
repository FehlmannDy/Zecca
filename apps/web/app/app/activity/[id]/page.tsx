import type { Metadata } from 'next'
import { ActivityDetail } from '@/components/send/activity-detail'

export const metadata: Metadata = { title: 'Details' }

export default async function ActivityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ActivityDetail id={id} />
}
