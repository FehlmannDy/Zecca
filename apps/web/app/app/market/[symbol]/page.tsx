import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AssetScreen } from '@/components/market/asset-screen'
import { symbolOf } from '@/components/market/market-model'

export const metadata: Metadata = { title: 'Metals' }

export default async function MarketAssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = symbolOf((await params).symbol)
  if (!symbol) notFound()
  return <AssetScreen symbol={symbol} />
}
