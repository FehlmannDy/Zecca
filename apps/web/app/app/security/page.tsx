import type { Metadata } from 'next'
import { AddFaceId } from '@/components/passkey/add-face-id'

export const metadata: Metadata = { title: 'Add Face ID' }

export default function SecurityPage() {
  return <AddFaceId />
}
