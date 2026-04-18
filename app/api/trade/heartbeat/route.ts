import { NextResponse } from 'next/server'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'

/**
 * POST /api/trade/heartbeat
 *
 * Sends a heartbeat to Polymarket CLOB to keep open orders alive.
 * Per docs: if heartbeats are not sent regularly, all open orders
 * for the user will be automatically cancelled.
 *
 * Should be called every ~25 seconds when auto-trading is active.
 * Reference: https://docs.polymarket.com/api-reference/trade/send-heartbeat.md
 */
export async function POST(request: Request) {
  let clientCreds: Partial<ClobCreds> | undefined
  try {
    const raw = await request.text()
    if (raw) clientCreds = JSON.parse(raw)
  } catch { /* ignore */ }

  const creds = resolveCredentials(clientCreds)
  if (!creds) {
    return NextResponse.json({ error: 'No credentials' }, { status: 401 })
  }

  try {
    const path = '/heartbeat'
    const headers = await buildClobHeaders(creds, 'POST', path, '{}')
    const res = await fetch(`${CLOB_HOST}${path}`, {
      method: 'POST',
      headers,
      body: '{}',
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text, status: res.status }, { status: res.status })
    }

    return NextResponse.json({ success: true, timestamp: Date.now() })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
