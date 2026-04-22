import { NextRequest, NextResponse } from 'next/server'

// Fungsi dummy sementara untuk mengambil balance
// Ganti fungsi ini dengan implementasi API Polymarket/CLOB yang sesuai
async function fetchBalanceFromPolymarket(funderAddress: string): Promise<number> {
  console.log(`[Portfolio API] Fetching balance for ${funderAddress}...`)
  
  // TODO: Panggil API Polymarket/CLOB asli di sini
  // Contoh:
  // const res = await fetch(`https://clob.polymarket.com/account/${funderAddress}`)
  // const data = await res.json()
  // return parseFloat(data.available_balance || '0')
  
  // Sementara return dummy value agar UI tidak kosong saat testing
  return 150.00 
}

export async function GET(request: NextRequest) {
  try {
    // 1. Ambil kredensial dari Header Request
    const credsHeader = request.headers.get('X-Clob-Creds')
    
    if (!credsHeader) {
      return NextResponse.json({ 
        configured: false, 
        error: 'No credentials provided in header' 
      }, { status: 400 })
    }

    let creds
    try {
      creds = JSON.parse(credsHeader)
    } catch (e) {
      return NextResponse.json({ 
        configured: false, 
        error: 'Invalid credentials format' 
      }, { status: 400 })
    }

    const { funderAddress } = creds

    if (!funderAddress) {
      return NextResponse.json({ 
        configured: false, 
        error: 'Funder address missing' 
      }, { status: 400 })
    }

    // 2. Fetch Balance Real dari Polymarket/CLOB
    const balance = await fetchBalanceFromPolymarket(funderAddress)

    // 3. Siapkan Data Portfolio
    const stats = {
      total_balance: balance,
      available_balance: balance,
      total_value: balance, // Asumsi sementara
      total_pnl: 0, // Hitung di client atau fetch dari history API
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
    })

  } catch (error) {
    console.error('[Portfolio API] Error:', error)
    return NextResponse.json({ 
      error: 'Internal Server Error', 
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
