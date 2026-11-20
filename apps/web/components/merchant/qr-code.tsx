'use client'
// A QR code of a payment link (qrcode package), always dark on light so any phone camera reads it, in both themes.
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { cn } from '@/lib/cn'
import { Skeleton } from '@/components/zecca/bits'

export function QrCode({ value, label, className, dark = '#0c0c0d', light = '#ffffff' }: { value: string; label: string; className?: string; dark?: string; light?: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setSvg(null)
    QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark, light } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(''))
    return () => {
      live = false
    }
  }, [value, dark, light])
  return (
    <div className={cn('aspect-square rounded-[20px] p-4', className)} style={{ background: light }}>
      {svg ? (
        <div role="img" aria-label={label} className="size-full [&>svg]:block [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : svg === '' ? (
        <p className="grid size-full place-items-center text-center text-[14px]" style={{ color: dark }}>
          The code could not be drawn. Share the link instead.
        </p>
      ) : (
        <Skeleton className="size-full" />
      )}
    </div>
  )
}
