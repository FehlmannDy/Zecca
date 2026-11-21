// The phone home's balance sparkline (same series as the wide Peak Chart, lib/balance-series), as SVG paths.
import { formatUsd } from '@zecca/contracts'

export type SparkGeometry = { line: string; area: string; end: { xPct: number; yPct: number } }

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Oldest point on the left, the balance now on the right. Zero sits at the bottom, so a small change looks small.
 * `inset` keeps the stroke inside the box at the top and bottom. Null with fewer than two points.
 */
export function sparkGeometry(values: number[], { width = 100, height = 64, inset = 4 } = {}): SparkGeometry | null {
  if (values.length < 2) return null
  const max = Math.max(0, ...values)
  const y = (v: number) => r2(height - inset - (max > 0 ? Math.max(0, v) / max : 0) * (height - 2 * inset))
  const x = (i: number) => r2((i / (values.length - 1)) * width)
  const pts = values.map((v, i) => [x(i), y(v)] as const)
  const line = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join('')
  const last = pts[pts.length - 1]
  return { line, area: `${line}L${width} ${height}L0 ${height}Z`, end: { xPct: (last[0] / width) * 100, yPct: (last[1] / height) * 100 } }
}

export function sparkLabel(values: number[], mode: 'daily' | 'running'): string {
  return `Balance ${mode === 'daily' ? 'by day' : 'today'}, from ${formatUsd(values[0])} to ${formatUsd(values[values.length - 1])}`
}
