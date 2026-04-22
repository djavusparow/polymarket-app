import { NextRequest, NextResponse } from 'next/server'
import { resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

// Konfigurasi Blockchain Polygon
const POLYGON_RPC_URL = 'https://polygon-rpc.com'
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

/**
 * Fungsi untuk memanggil kontrak pintar USDC di Polygon
 * Menggunakan metode eth_call untuk mengambil balanceOf(address)
 */
async function getOnChainUSDCBalance(address: string): Promise<number> {
  // ABI minimal untuk fungsi balanceOf(address)
  // selector untuk balanceOf(address) adalah 0x70a08231
  const data = '0x70a08231' + address.toLowerCase().replace('0x', '').padStart(64, '0')

  try {
    const response = await fetch(POLYGON_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [
          {
            to: USDC_CONTRACT_ADDRESS,
            data: data,
          },
          'latest',
        ],
        id: 1,
      }),
    })

    if (!response.ok) throw new Error(`RPC Error: ${response.status}`)

    const result = await response.json()
    if (result.error) throw new Error(`RPC Error: ${result.error.message}`)

    // Hasil balance dalam hex (misal: 0x0000...0001a2b3c4)
    const hexBalance = result.result
    const balanceWei = BigInt(hexBalance)
    
    // USDC di Polygon memiliki 6 desimal
    return Number(balanceWei) / 1_000_000
  } catch (error) {
    console.error('[On-Chain Balance Error]:', error)
    throw error
  }
}

export async function GET(request: NextRequest) {
  try {
    const credsHeader = request.headers.get('X-Clob-Creds')
    let clientCreds: Partial<ClobCreds> | undefined
    if (credsHeader) {
      try { clientCreds = JSON.parse(credsHeader) } catch { /* ignore */ }
    }

    const creds = resolveCredentials(clientCreds)
    if (!creds || !creds.funderAddress) {
      return NextResponse.json({ 
        configured: false, 
        error: 'No credentials or funder address provided' 
      }, { status: 400 })
    }

    console.log(`[Portfolio API] Fetching on-chain balance for proxy wallet: ${creds.funderAddress}`)

    // AMBIL BALANCE LANGSUNG DARI BLOCKCHAIN
    const balance = await getOnChainUSDCBalance(creds.funderAddress)
    
    console.log(`[Portfolio API] Successfully fetched balance: $${balance}`)

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
      balance: balance,
      stats: stats,
      timestamp: new Date().toISOString(),
      method: 'on-chain'
    })

  } catch (error: any) {
    console.error('[Portfolio API] Global Error:', error)
    return NextResponse.json({ 
      error: 'Failed to fetch balance', 
      details: error.message 
    }, { status: 500 })
  }
}
