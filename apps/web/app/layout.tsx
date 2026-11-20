import type { Metadata, Viewport } from 'next'
import '@fontsource-variable/manrope'
import '@fontsource/montserrat/500.css'
import './globals.css'
import { AppProvider } from '@/lib/app'

export const metadata: Metadata = {
  title: { default: 'Zecca', template: '%s · Zecca' },
  description: 'Money that moves like a message. Private by default.',
  icons: { icon: '/brand/zecca-logo.png' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f2eb' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0d0f' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  )
}
