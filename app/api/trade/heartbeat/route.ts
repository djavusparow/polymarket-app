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
 * Should be called every ~5-10 seconds when auto-trading is active.
 * Reference: https://docs.polymarket.com/api-reference/trade/send-heartbeat.md
 */
export async function POST(request: Request) {
  let clientCreds: Partial<ClobCreds> & { heartbeat_id?: string } | undefined
  try {
    const raw = await request.text()
    if (raw) clientCreds = JSON.parse(raw)
  } catch { /* ignore */ }

  const creds = resolveCredentials(clientCreds)
  if (!creds) {
    return NextResponse.json({ error: 'No credentials' }, { status: 401 })
  }

  try {
    // Correct endpoint path (plural 'heartbeats')
    const path = '/heartbeats'
    
    // Include heartbeat_id if provided in previous response
    const bodyPayload = { 
      heartbeat_id: clientCreds?.heartbeat_id || "" 
    }
    const bodyStr = JSON.stringify(bodyPayload)

    const headers = await buildClobHeaders(creds, 'POST', path, bodyStr)
    
    const res = await fetch(`${CLOB_HOST}${path}`, {
      method: 'POST',
      headers,
      body: bodyStr,
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text, status: res.status }, { status: res.status })
    }

    // Parse response to get new heartbeat_id
    const responseData = await res.json() as { heartbeat_id?: string }

    return NextResponse.json({ 
      success: true, 
      timestamp: Date.now(),
      heartbeat_id: responseData.heartbeat_id 
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
