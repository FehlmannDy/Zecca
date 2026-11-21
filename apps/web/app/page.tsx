import type { Metadata } from 'next'
import { HERO } from '@/components/landing/content'
import { Landing } from '@/components/landing/landing'

export const metadata: Metadata = {
  title: { absolute: 'Zecca · Pay, spend, earn and own gold' },
  description: HERO.sub,
}

export default function Home() {
  return <Landing />
}
