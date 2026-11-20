import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = { title: 'Zecca', description: 'Money that moves like a message. Private by default.' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
