'use client'
// Get paid (/app/request): the user's @handle and a QR code of WEB_ORIGIN/app/send?to=<handle>, with copy and share.
import { useEffect, useState } from 'react'
import { Check, Copy, Share2 } from 'lucide-react'
import { Avatar, Button, Skeleton } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { useApp } from '@/lib/app'
import { useSession } from '@/lib/session'
import { QrCode } from './qr-code'
import { requestLink } from './request-link'

export function RequestScreen() {
  const { config } = useApp()
  const user = useSession()?.user
  const [copied, setCopied] = useState(false)
  const [canShare, setCanShare] = useState(false)
  useEffect(() => setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'), [])

  const link = config && user ? requestLink(config.webOrigin, user.handle) : null

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked: the link is on screen to select */
    }
  }
  async function share() {
    if (!link || !user) return
    try {
      await navigator.share({ title: 'Pay me on Zecca', text: `Send me money on Zecca: @${user.handle}`, url: link })
    } catch {
      /* closed the share sheet */
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
      <h1 className="px-1 text-[22px] font-[740] tracking-[-0.02em]">Get paid</h1>
      <Panel className="flex flex-col items-center text-center">
        {!user || !link ? (
          <div className="flex flex-col items-center gap-3 py-4" aria-busy="true" aria-label="Loading">
            <Skeleton className="size-14 rounded-full" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="size-[232px] rounded-[16px]" />
          </div>
        ) : (
          <>
            <Avatar name={user.displayName} size={56} business={user.role.includes('merchant')} />
            <p className="mt-3 text-[17px] font-[680]">{user.displayName}</p>
            <p className="text-[22px] font-[740] tracking-[-0.02em]">@{user.handle}</p>
            <QrCode value={link} label={`QR code to pay @${user.handle}`} className="mt-5 size-[232px] border border-line p-1" />
            <p className="mt-5 max-w-[30ch] text-[15px] text-muted">Ask them to scan this, or send them the link.</p>
            <p className="mt-3 max-w-full truncate rounded-full border border-line bg-surface px-3 py-1.5 font-mono text-[12.5px] text-ink" title={link}>
              {link.replace(/^https?:\/\//, '')}
            </p>
            <div className="mt-5 flex w-full flex-col gap-2 sm:flex-row">
              {canShare && (
                <Button className="w-full sm:flex-1" onClick={share}>
                  <Share2 className="size-4" aria-hidden="true" /> Share link
                </Button>
              )}
              <Button variant={canShare ? 'secondary' : 'primary'} className="w-full sm:flex-1" onClick={copy}>
                {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
            <p className="sr-only" aria-live="polite">
              {copied ? 'Link copied' : ''}
            </p>
          </>
        )}
      </Panel>
    </div>
  )
}
