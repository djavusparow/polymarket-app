import { NextRequest, NextResponse } from 'next/server'
import { getCredentials } from '@/lib/trade-engine' // Pastikan fungsi ini ada
import type { PortfolioStats } from '@/lib/types'

// Fungsi dummy sederhana untuk menghitung sisa USDC (Ganti dengan logika fetch Polymarket/CLOB asli)
// Ini adalah logika minimal agar balance muncul
async function fetchBalanceFromPolymarket(funderAddress: string): Promise<number> {
  // TODO: Ganti dengan panggilan API Polymarket/CLOB yang sesuai
  // Contoh: const res = await fetch(`https://clob.polymarket.com/account/${funderAddress}`)
  // const data = await res.json()
  // return parseFloat(data.available_balance || data.balance || '0')
  
  console.log(`Fetching balance for ${funderAddress}...`)
  // Dummy return agar tidak kosong (HAPUS SETELAH INTEGRASI API REAL)
  return 150.00 
}

export async function GET(request: NextRequest) {
  try {
    // 1. Ambil kredensial dari header atau local storage (server-side)
    const credsHeader = request.headers.get('X-Clob-Creds')
    
    let creds = null
    if (credsHeader) {
      try {
        creds = JSON.parse(credsHeader)
      } catch (e) {
        console.error('Failed to parse creds header')
      }
    }
    
    // Fallback: Coba ambil dari environment atau database user jika ada session
    if (!creds) {
        // Cek apakah Anda punya logika session di sini
        // Jika tidak, user harus mengisi settings dulu
        return NextResponse.json({ configured: false, error: 'No credentials provided' }, { status: 400 })
    }

    const { funder_address } = creds

    if (!funder_address) {
      return NextResponse.json({ configured: false, error: 'Funder address missing' }, { status: 400 })
    }

    // 2. Fetch Balance Real (Ganti fungsi dummy ini dengan implementasi asli)
    const balance = await fetchBalanceFromPolymarket(funder_address)

    // 3. Siapkan Response
    const portfolioStats: PortfolioStats = {
      total_balance: balance,
      available_balance: balance,
      total_value: balance, // Asumsi belum ada posisi terbuka yang dihitung di sini
      total_pnl: 0, // Dihitung di client atau fetch dari API history
      total_pnl_pct: 0,
      today_pnl: 0,
      today_trades: 0,
      win_rate: 0,
      open_positions: 0,
    }

    return NextResponse.json({
      configured: true,
      balance: balance,
      stats: portfolioStats,
      timestamp: new Date().toISOString(),
    })

  } catch (error) {
    console.error('[Portfolio API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
