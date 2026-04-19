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
  } catch {
    /* ignore */
  }

  const creds = resolveCredentials(clientCreds)

  if (!creds) {
    return NextResponse.json({
      balance: 0,
      positions: [],
      orders: [],
      configured: false,
      message:
        'Credentials not configured. Enter your API credentials in Settings.',
    })
  }

  try {
    // ── 1. USDC Balance from CLOB (L2 authenticated) ──────────────────────────
    // asset_type=0 → USDC
    const balPath = '/balance-allowance?asset_type=0'
    const balHeaders = await buildClobHeaders(creds, 'GET', balPath)

    const [balRes, ordersRes, posRes] = await Promise.all([
      fetch(`${CLOB_HOST}${balPath}`, { headers: balHeaders, cache: 'no-store' }),

      // ── 2. Open orders from CLOB (L2 authenticated) ───────────────────────
      (async () => {
        const ordPath = '/orders'
        const ordHeaders = await buildClobHeaders(creds, 'GET', ordPath)
        return fetch(`${CLOB_HOST}${ordPath}`, {
          headers: ordHeaders,
          cache: 'no-store',
        })
      })(),

      // ── 3. Open Positions from Data API (public by wallet address) ────────
      fetch(
        `${DATA_HOST}/v2/positions?user=${encodeURIComponent(
          creds.funderAddress
        )}&sizeThreshold=.1`,
        { cache: 'no-store' }
      ),
    ])

    // ---------- Balance parsing (fixed) ----------
    let balance = 0
    if (balRes.ok) {
      const balData = await balRes.json()
      const rawBalance = balData?.balance // <-- only read the proper field
      const parsed = typeof rawBalance === 'string' ? parseFloat(rawBalance) : rawBalance

      // Pastikan kita mendapat angka yang valid sebelum scaling.
      if (typeof parsed === 'number' && !isNaN(parsed)) {
        // Jika nilai yang diterima adalah integer besar (misal 1 000 000 USDC * 1e6),
        // ubah menjadi satuan USDC standar dengan membagi 1 000 000.
        balance = parsed >= 1_000 ? parsed / 1_000_000 : parsed
      }
    }

    // ---------- Positions ----------
    let positions: unknown[] = []
    if (posRes.ok) {
      const posData = await posRes.json()
      positions = Array.isArray(posData) ? posData : posData?.results ?? []
    }

    // ---------- Orders ----------
    let orders: unknown[] = []
    if (ordersRes.ok) {
      const ordData = await ordersRes.json()
      orders = Array.isArray(ordData) ? ordData : ordData?.data ?? []
    }

    return NextResponse.json({
      balance,
      positions,
      orders,
      configured: true,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json(
      {
        balance: 0,
        positions: [],
        orders: [],
        configured: true,
        error: `Portfolio fetch failed: ${msg}`,
      },
      { status: 500 }
    )
  }
}
