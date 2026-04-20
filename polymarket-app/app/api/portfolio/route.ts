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
    // Perbaikan: asset_type=COLLATERAL untuk USDC (bukan asset_type=0)
    const balPath = '/balance-allowance?asset_type=COLLATERAL'
    const balHeaders = await buildClobHeaders(creds, 'GET', balPath)

    // ── 2. Open orders from CLOB (L2 authenticated) ─────────────────────────
    const ordPath = '/orders'
    const ordHeaders = await buildClobHeaders(creds, 'GET', ordPath)

    // ── 3. Open Positions from Data API (public by wallet address) ──────────
    const posUrl = `${DATA_HOST}/positions?user=${encodeURIComponent(
      creds.funderAddress
    )}&sizeThreshold=.1`

    // Perbaikan: Gunakan Promise.allSettled untuk individual error handling
    const [balRes, ordersRes, posRes] = await Promise.allSettled([
      fetch(`${CLOB_HOST}${balPath}`, { headers: balHeaders, cache: 'no-store' }),
      fetch(`${CLOB_HOST}${ordPath}`, { headers: ordHeaders, cache: 'no-store' }),
      fetch(posUrl, { cache: 'no-store' }),
    ])

    // ---------- Balance parsing (fixed) ----------
    let balance = 0
    if (balRes.status === 'fulfilled' && balRes.value.ok) {
      try {
        const balData = await balRes.value.json()
        const rawBalance = balData?.balance
        const parsed =
          typeof rawBalance === 'string' ? parseFloat(rawBalance) : rawBalance

        // Pastikan kita mendapat angka yang valid sebelum scaling.
        if (typeof parsed === 'number' && !isNaN(parsed)) {
          // Perbaikan: USDC memiliki 6 decimals. Jika nilai >= 1,000,000 (1 USDC),
          // bagi dengan 1,000,000 untuk mengonversi ke satuan USDC standar.
          balance = parsed >= 1_000_000 ? parsed / 1_000_000 : parsed
        }
      } catch (e) {
        console.error('Error parsing balance:', e)
      }
    }

    // ---------- Positions ----------
    let positions: unknown[] = []
    if (posRes.status === 'fulfilled' && posRes.value.ok) {
      try {
        const posData = await posRes.value.json()
        positions = Array.isArray(posData) ? posData : posData?.results ?? []
      } catch (e) {
        console.error('Error parsing positions:', e)
      }
    }

    // ---------- Orders ----------
    let orders: unknown[] = []
    if (ordersRes.status === 'fulfilled' && ordersRes.value.ok) {
      try {
        const ordData = await ordersRes.value.json()
        orders = Array.isArray(ordData) ? ordData : ordData?.data ?? []
      } catch (e) {
        console.error('Error parsing orders:', e)
      }
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
