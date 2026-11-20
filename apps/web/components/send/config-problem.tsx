'use client'
// When GET /v1/config failed: its message and Retry (UI.md §6), instead of a screen that waits for ever.
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { useApp } from '@/lib/app'

export function ConfigProblem() {
  const { config, configError, reloadConfig } = useApp()
  if (config || !configError) return null
  return (
    <Panel role="alert" className="flex flex-col items-start gap-3">
      <p className="text-[15px]">{configError.message}</p>
      <Button variant="secondary" className="min-h-11" onClick={reloadConfig}>
        <RotateCw className="size-4" aria-hidden="true" /> Retry
      </Button>
    </Panel>
  )
}
