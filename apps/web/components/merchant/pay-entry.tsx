'use client'
// /app/pay: the in-app "Pay" entry. Scan the merchant's code (BarcodeDetector, where the browser has it), tap phones
// (the phone opens the link itself), or paste a payment link.
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Nfc, ScanLine } from 'lucide-react'
import { Button } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { payLinkTarget } from './pay-model'

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }
type DetectorCtor = new (opts: { formats: string[] }) => Detector

const inputCls =
  'h-12 w-full min-w-0 rounded-[14px] border border-line bg-surface px-4 text-[16px] text-ink placeholder:text-muted/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brass)]'

export function PayEntry() {
  const router = useRouter()
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [canScan, setCanScan] = useState(false)
  const [scanning, setScanning] = useState(false)
  useEffect(() => setCanScan('BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia), [])

  function open(text: string) {
    const to = payLinkTarget(text)
    if (!to) {
      setError("That isn't a Zecca payment link. Check it and try again.")
      return false
    }
    router.push(to)
    return true
  }

  return (
    <div className="mx-auto flex max-w-[520px] flex-col gap-4">
      <div>
        <p className="label-caps text-muted">Pay</p>
        <h1 className="mt-2 text-[28px] font-[760] leading-tight tracking-[-0.035em]">Pay a merchant</h1>
        <p className="mt-2 text-[16px] text-muted">Scan the merchant&apos;s code with your camera, or hold your phone to theirs.</p>
      </div>

      <Panel>
        <ul className="space-y-4 text-[15px]">
          <li className="flex gap-3">
            <ScanLine className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
            <span>Point your phone&apos;s camera at the code on the merchant&apos;s screen. The payment opens by itself.</span>
          </li>
          <li className="flex gap-3">
            <Nfc className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
            <span>Or hold the top of your phone to the back of theirs and open the link that appears.</span>
          </li>
        </ul>
        {canScan && (
          <Button className="mt-5 w-full" onClick={() => setScanning(true)}>
            <Camera className="size-5" aria-hidden="true" />
            Scan a code
          </Button>
        )}
      </Panel>

      {scanning && (
        <Scanner
          onCode={(raw) => {
            if (open(raw)) setScanning(false)
          }}
          onClose={() => setScanning(false)}
        />
      )}

      <Panel title="Have a link?">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setError('')
            open(link)
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="sr-only">Payment link</span>
            <input
              className={inputCls}
              value={link}
              onChange={(e) => {
                setLink(e.target.value)
                setError('')
              }}
              placeholder="Paste a payment link"
              inputMode="url"
              autoComplete="off"
              aria-invalid={!!error}
              aria-describedby="pay-link-msg"
            />
          </label>
          <Button type="submit" disabled={!link.trim()}>
            Open
          </Button>
        </form>
        <p id="pay-link-msg" className="mt-2 min-h-5 text-[14px] text-alert" aria-live="polite">
          {error}
        </p>
      </Panel>
    </div>
  )
}

function Scanner({ onCode, onClose }: { onCode: (raw: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const handlers = useRef({ onCode })
  handlers.current = { onCode }
  useEffect(() => {
    let stream: MediaStream | null = null
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    ;(async () => {
      try {
        const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector
        const detector = new Ctor({ formats: ['qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        if (stop || !video.current) return
        video.current.srcObject = stream
        await video.current.play()
        const tick = async () => {
          if (stop || !video.current) return
          try {
            const codes = await detector.detect(video.current)
            if (codes[0]?.rawValue) handlers.current.onCode(codes[0].rawValue)
          } catch {
            /* a frame that could not be read */
          }
          timer = setTimeout(tick, 250)
        }
        tick()
      } catch {
        setError("We can't use the camera. Allow it in your browser's settings, or paste the link below.")
      }
    })()
    return () => {
      stop = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])
  return (
    <Panel title="Scan the merchant's code" action={<Button variant="ghost" className="min-h-11" onClick={onClose}>Close</Button>}>
      {error ? (
        <p className="text-[15px] text-alert" role="alert">
          {error}
        </p>
      ) : (
        <video ref={video} className="aspect-square w-full rounded-[16px] bg-ink object-cover" muted playsInline aria-label="Camera" />
      )}
    </Panel>
  )
}
