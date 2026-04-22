// app/api/portfolio/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

/* ------------------------------------------------------------------
   Konfigurasi RPC Polygon
   - Anda dapat men‑override dengan env‑var POLYGON_RPC_URL
   - Daftar fallback public RPC (tidak memerlukan API key)
------------------------------------------------------------------- */
const DEFAULT_RPC_ENDPOINTS = [
  'https://polygon-rpc.com',                     // public, kadang rate‑limited
  'https://rpc.ankr.com/polygon',               // ankr, public
  'https://cloudflare-eth.com',                 // Cloudflare (Ethereum mainnet) – tetapi masih dapat dipakai untuk Polygon via eth_call (sama saja)
]

const RPC_ENDPOINT = process.env.POLYGON_RPC_URL?.trim() || ''
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // USDC di Polygon (6 desimal)

/**
 * Membuat payload `eth_call` untuk fungsi ERC‑20 `balanceOf(address)`.
 * selector untuk balanceOf = 0x70a08231
 */
function buildBalanceOfPayload(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '')
  return '0x70a08231' + clean.padStart(64, '0')
}

/**
 * Mencoba membaca saldo USDC dari satu RPC endpoint.
 * Mengembalikan `null` bila request gagal (status != 200 atau error RPC).
 */
async function tryRpcBalance(rpcUrl: string, address: string): Promise<number | null> {
  const payload = buildBalanceOfPayload(address)

  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: USDC_CONTRACT_ADDRESS, data: payload }, 'latest'],
        id: 1,
      }),
    })

    // 401, 403, atau non‑200 menandakan RPC menolak request
    if (!resp.ok) {
      console.warn(`[RPC] ${rpcUrl} responded ${resp.status}`)
      return null
    }

    const json = await resp.json()
    if (json.error) {
      console.warn(`[RPC] ${rpcUrl} error: ${json.error.message}`)
      return null
    }

    const hexBalance = json.result as string
    const balanceWei = BigInt(hexBalance)

    // USDC memiliki 6 desimal pada Polygon
    return Number(balanceWei) / 1_000_000
  } catch (e) {
    console.warn(`[RPC] ${rpcUrl} threw:`, (e as Error).message)
    return null
  }
}

/**
 * Loop melalui daftar RPC (custom → default) sampai salah satu berhasil.
 * Jika semua gagal, melempar error.
 */
async function getOnChainUSDCBalance(address: string): Promise<number> {
  // 1️⃣ Jika ada env‑var khusus, coba dulu
  const candidates = RPC_ENDPOINT ? [RPC_ENDPOINT] : DEFAULT_RPC_ENDPOINTS

  for (const rpc of candidates) {
    const bal = await tryRpcBalance(rpc, address)
    if (bal !== null) {
      console.log(`[Portfolio API] Balance fetched via ${rpc}: $${bal}`)
      return bal
    }
  }

  // Jika sampai sini semua RPC gagal → lempar error
  throw new Error('All Polygon RPC endpoints failed (401/Rate‑limit/Network).')
}

/* ------------------------------------------------------------------
   Handler GET /api/portfolio
------------------------------------------------------------------- */
export async function GET(request: NextRequest) {
  try {
    // -----------------------------------------------------------------
    // 1️⃣ Baca kredensial (hanya untuk mengambil address proxy)
    // -----------------------------------------------------------------
    const credsHeader = request.headers.get('X-Clob-Creds')
    let clientCreds: Partial<ClobCreds> | undefined
    if (credsHeader) {
      try { clientCreds = JSON.parse(credsHeader) } catch { /* ignore */ }
    }
    const creds = resolveCredentials(clientCreds)

    if (!creds?.funderAddress) {
      return NextResponse.json(
        { configured: false, error: 'No proxy wallet address supplied' },
        { status: 400 }
      )
    }

    console.log(`[Portfolio API] Fetching on‑chain balance for proxy wallet: ${creds.funderAddress}`)

    // -----------------------------------------------------------------
    // 2️⃣ Ambil saldo USDC langsung dari blockchain
    // -----------------------------------------------------------------
    const balance = await getOnChainUSDCBalance(creds.funderAddress)

    // -----------------------------------------------------------------
    // 3️⃣ Bangun objek statistik (untuk UI Portfolio)
    // -----------------------------------------------------------------
    const stats = {
      total_balance: balance,
      available_balance: balance,
      total_value: balance,
      total_pnl: 0,
      total_pnl_pct: 0,
      today_pnl: 0,
      today_trades: 0,
      win_rate: 0,
      open_positions: 0,
    }

    return NextResponse.json({
      configured: true,
      balance,
      stats,
      timestamp: new Date().toISOString(),
      method: 'on-chain',
    })
  } catch (error: any) {
    console.error('[Portfolio API] Global Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch on‑chain balance', details: error.message },
      { status: 500 }
    )
  }
}
