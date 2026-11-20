'use client'
// A QR code drawn as one SVG path (no canvas, no innerHTML), ink on a white tile so phone cameras read it in
// both themes.
import { useMemo } from 'react'
import { create } from 'qrcode'
import { cn } from '@/lib/cn'

export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => {
    const m = create(value, { errorCorrectionLevel: 'M' }).modules
    let path = ''
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) path += `M${c} ${r}h1v1h-1z`
    return { size: m.size, d: path }
  }, [value])
  const pad = 2
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${size + pad * 2} ${size + pad * 2}`}
      className={cn('block rounded-[16px] bg-white', className)}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <path d={d} fill="#0c0c0d" />
    </svg>
  )
}
