// <xrpl-wallet-connector> (xrpl-connect): signing through the Privy adapter fails closed without it on the page.
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'xrpl-wallet-connector': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}
