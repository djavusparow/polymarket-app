import { NextResponse } from 'next/server'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'
const DATA_HOST = 'https://data-api.polymarket.com'

/**
 * GET /api/portfolio
 *
 * Returns:
 *   - balance    : USDC balance from CLOB /balance-allowance
 *   - positions  : open positions from Data API /v2/positions (by funder address — public)
 *   - orders     : open orders from CLOB /orders (authenticated)
 *   - configured : whether credentials are set
 *
 * Credentials passed via X-Clob-Creds header (JSON) when env vars are not set.
 */
export async function GET(request: Request) {
  let clientCreds: Partial<ClobCreds> | undefined
  try {
    const raw = request.headers.get('X-Clob-Creds')
    if (raw) clientCreds = JSON.parse(raw)
  } catch { /* ignore */ }

  const creds = resolveCredentials(clientCreds)

  if (!creds) {
    return NextResponse.json({
      balance: 0,
      positions: [],
      orders: [],
      configured: false,
      message: 'Credentials not configured. Enter your API credentials in Settings.',
    })
  }

  try {
    // ── 1. USDC Balance from CLOB (L2 authenticated) ──────────────────────────
    // Correct endpoint: asset_type=0 means USDC, asset_type=1 means conditional token
    // Ref: https://docs.polymarket.com/developers/CLOB/rest-api/balances
    const balPath = '/balance-allowance?asset_type=0'
    const balHeaders = await buildClobHeaders(creds, 'GET', balPath)

    console.log('[api/portfolio] env check — CLOB_API_KEY:', !!process.env.CLOB_API_KEY, 'FUNDER_ADDRESS:', !!process.env.FUNDER_ADDRESS)
    console.log('[api/portfolio] funderAddress:', creds.funderAddress)
    console.log('[api/portfolio] calling CLOB:', `${CLOB_HOST}${balPath}`)

    const [balRes, ordersRes, posRes] = await Promise.all([
      fetch(`${CLOB_HOST}${balPath}`, { headers: balHeaders, cache: 'no-store' }),
      // ── 2. Open orders from CLOB (L2 authenticated) ───────────────────────
      (async () => {
        const ordPath = '/orders'
        const ordHeaders = await buildClobHeaders(creds, 'GET', ordPath)
        return fetch(`${CLOB_HOST}${ordPath}`, { headers: ordHeaders, cache: 'no-store' })
      })(),
      // ── 3. Open Positions from Data API (public by wallet address) ────────
      fetch(
        `${DATA_HOST}/v2/positions?user=${encodeURIComponent(creds.funderAddress)}&sizeThreshold=.1`,
        { cache: 'no-store' }
      ),
    ])

    let balance = 0
    console.log('[api/portfolio] balance HTTP status:', balRes.status)
    if (balRes.ok) {
      const balData = await balRes.json()
      console.log('[api/portfolio] raw balance response:', JSON.stringify(balData))
      // CLOB returns balance as decimal string, e.g. "5.23" for $5.23
      // Older versions may return in micro-USDC (1e6) units — handle both
      const raw = parseFloat(
        balData?.balance ?? balData?.USDC ?? balData?.asset ?? '0'
      )
      if (!isNaN(raw)) {
        balance = raw >= 1_000 ? raw / 1_000_000 : raw
      }
    } else {
      const errText = await balRes.text()
      console.log('[api/portfolio] balance HTTP error:', balRes.status, errText)
    }

    let positions: unknown[] = []
    if (posRes.ok) {
      const posData = await posRes.json()
      positions = Array.isArray(posData) ? posData : posData?.results ?? []
      console.log('[api/portfolio] positions count:', positions.length)
    } else {
      console.log('[api/portfolio] positions error:', posRes.status, await posRes.text())
    }

    let orders: unknown[] = []
    if (ordersRes.ok) {
      const ordData = await ordersRes.json()
      orders = Array.isArray(ordData) ? ordData : ordData?.data ?? []
    } else {
      console.log('[api/portfolio] orders error:', ordersRes.status)
    }

    console.log('[api/portfolio] final balance:', balance)

    return NextResponse.json({
      balance,
      positions,
      orders,
      configured: true,
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.log('[api/portfolio] catch error:', msg)
    return NextResponse.json(
      { balance: 0, positions: [], orders: [], configured: true, error: `Portfolio fetch failed: ${msg}` },
      { status: 500 }
    )
  }
}
