// MoonPay's web SDK, loaded on demand the way ../moonpay-ramp/public/index.html did (overlay variant, signature from our API).
const SDK_SRC = 'https://static.moonpay.com/web-sdk/v1/moonpay-web-sdk.min.js'

export type MoonPayWidget = {
  show(): void
  close?(): void
  generateUrlForSigning(): string
  updateSignature(signature: string): void
}
type Handlers = Partial<Record<'onTransactionCreated' | 'onTransactionCompleted' | 'onUnsupportedRegion' | 'onClose', (props?: unknown) => Promise<void>>>
export type MoonPaySdk = {
  init(o: { flow: 'buy'; environment: 'sandbox' | 'production'; variant: 'overlay'; params: Record<string, string>; handlers?: Handlers }): MoonPayWidget
}

declare global {
  interface Window {
    MoonPayWebSdk?: MoonPaySdk
  }
}

let loading: Promise<MoonPaySdk> | null = null

export function loadMoonPaySdk(): Promise<MoonPaySdk> {
  if (window.MoonPayWebSdk) return Promise.resolve(window.MoonPayWebSdk)
  loading ??= new Promise<MoonPaySdk>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SDK_SRC
    s.async = true
    s.onload = () => (window.MoonPayWebSdk ? resolve(window.MoonPayWebSdk) : reject(new Error('MoonPay SDK missing')))
    s.onerror = () => {
      s.remove()
      reject(new Error('MoonPay SDK did not load'))
    }
    document.head.appendChild(s)
  }).catch((e) => {
    loading = null
    throw e
  })
  return loading
}
