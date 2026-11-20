import type { Metadata } from 'next'
import { ActivityList } from '@/components/send/activity-list'

export const metadata: Metadata = { title: 'Activity' }

export default function ActivityPage() {
  return <ActivityList />
}
