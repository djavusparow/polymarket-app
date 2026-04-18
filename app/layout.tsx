import type { Metadata, Viewport } from 'next'
import { Inter, Fira_Code } from 'next/font/google'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const firaCode = Fira_Code({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '500', '600', '700'] })

export const metadata: Metadata = {
  title: 'Polytrade AI — Polymarket Auto Trading',
  description: 'AI-powered auto trading platform for Polymarket prediction markets with real-time signals and full auto execution.',
}

export const viewport: Viewport = {
  themeColor: '#0a0f1a',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark bg-background">
      <body className={`${inter.variable} ${firaCode.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  )
}
