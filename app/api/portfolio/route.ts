import { NextRequest, NextResponse } from 'next/server'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'

// Helper untuk menghitung P&L sederhana dari history (jika diperlukan, opsional)
// Di sini kita fokus pada balance saat ini

export async function GET(request: NextRequest) {
  try {
    // 1. Ambil Kredensial dari Header Request
    const credsHeader = request.headers.get('X-Clob-Creds')
    
    let clientCreds: Partial<ClobCreds> | undefined
    if (credsHeader) {
      try {
        clientCreds = JSON.parse(credsHeader)
      } catch (e) {
        console.error('Failed to parse creds header')
      }
    }

    // 2. Resolve Credentials (Gabungkan dari Header + Env Vars)
    const creds = resolveCredentials(clientCreds)
    
    if (!creds || !creds.funderAddress) {
      return NextResponse.json({ 
        configured: false, 
        error: 'No credentials or funder address provided' 
      }, { status: 400 })
    }

    // 3. Fetch Data dari Gamma API (Lebih stabil untuk informasi akun)
    // Gamma API adalah API publik Polymarket yang menyediakan data market dan user
    try {
      // Mengambil informasi akun (balance, positions) dari Gamma
      // Note: Gamma mungkin tidak selalu punya endpoint balance langsung per address,
      // tetapi kita bisa mendapatkan data token holdings atau menggunakan CLOB endpoint yang valid.
      
      // Coba gunakan endpoint Gamma yang umum untuk account stats
      const gammaRes = await fetch(`${GAMMA_HOST}/account/${creds.funderAddress}`, {
        method: 'GET',
        cache: 'no-store'
      })

      if (gammaRes.ok) {
        const accountData = await gammaRes.json()
        
        // Polymarket Gamma biasanya mengembalikan balance dalam field 'balance'
        // Jika tidak ada, coba cek field lain atau fallback
        const balanceStr = accountData.balance || accountData.availableBalance || '0'
        
        // Convert dari Wei ke USDC (USDC punya 6 desimal)
        // Polymarket seringkali menyimpan nilai dalam string numerik tanpa pembagian, 
        // atau dalam format yang perlu dikonversi. 
        // Cek tipe data: jika balance > 1000, kemungkinan besar dalam satuan USDC langsung (bukan wei).
        // Jika balance dalam bentuk hex/wei, gunakan Number(balanceStr) / 1e6.
        
        // Asumsi: Gamma mengembalikan balance dalam satuan USDC (float string)
        let balance = parseFloat(balanceStr)
        
        // Jika balance sangat besar (misal > 100 juta), asumsikan itu Wei dan bagi 1e6
        if (balance > 100000000) {
            balance = balance / 1e6
        }

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
        })
      } else {
        console.log(`Gamma API failed: ${gammaRes.status} ${gammaRes.statusText}`)
      }
    } catch (err) {
      console.error('Gamma Fetch Error:', err)
    }

    // 4. Fallback: Coba CLOB API (Endpoint yang valid)
    // Jika Gamma gagal, coba endpoint CLOB yang mungkin valid.
    // Seringkali balance ada di /account/me atau /user.
    try {
      const authHeaders = await buildClobHeaders(creds, 'GET', '/account/me', '')
      
      const clobRes = await fetch(`${CLOB_HOST}/account/me`, {
        method: 'GET',
        headers: authHeaders,
        cache: 'no-store'
      })

      if (clobRes.ok) {
        const data = await clobRes.json()
        // Struktur respons CLOB biasanya { "balance": "...", "heldTokens": [...] }
        const balanceStr = data.balance || data.availableBalance || '0'
        let balance = parseFloat(balanceStr) / 1e6 // Asumsi dalam Wei/Atom

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
        })
      }
    } catch (err) {
      console.error('CLOB Account Me Error:', err)
    }

    // Jika semua gagal, return 0 atau data dummy agar UI tidak crash
    return NextResponse.json({
      configured: true,
      balance: 0,
      stats: defaultPortfolio(),
      warning: 'Balance service unavailable, using fallback 0',
    })

  } catch (error: any) {
    console.error('[Portfolio API] Error:', error)
    return NextResponse.json({ 
      error: 'Internal Server Error', 
      details: error.message 
    }, { status: 500 })
  }
}

function defaultPortfolio() {
  return {
    total_balance: 0,
    available_balance: 0,
    total_value: 0,
    total_pnl: 0,
    total_pnl_pct: 0,
    today_pnl: 0,
    today_trades: 0,
    win_rate: 0,
    open_positions: 0,
  }
}
