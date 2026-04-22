// app/api/portfolio/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'

export async function GET(request: NextRequest) {
  try {
    // 1. Ambil Kredensial dari Header Request (dikirim dari page.tsx)
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

    // 3. Fetch Balance dari CLOB API (/account)
    // Endpoint ini umumnya lebih stabil untuk mendapatkan balance akun
    try {
      const authHeaders = await buildClobHeaders(creds, 'GET', `/account/${creds.funderAddress}`, '')
      
      const accountRes = await fetch(`${CLOB_HOST}/account/${creds.funderAddress}`, {
        method: 'GET',
        headers: authHeaders,
        cache: 'no-store'
      })

      if (accountRes.ok) {
        const accountData = await accountRes.json()
        // Polymarket biasanya menyimpan balance di field 'balance' atau 'availableBalance'
        // Di CLOB, balance seringkali berupa string wei (atau string numerik)
        const balanceStr = accountData.balance || accountData.availableBalance || '0'
        const balance = parseFloat(balanceStr) / 1e6 // USDC memiliki 6 desimal
        
        // 4. Siapkan Stats
        const stats = {
          total_balance: balance,
          available_balance: balance,
          total_value: balance, // Asumsi sementara tanpa posisi terbuka yang dihitung server-side
          total_pnl: 0, // PnL dihitung di client dari history trade lokal
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
        console.log(`CLOB Account API failed: ${accountRes.status}`)
      }
    } catch (err) {
      console.error('CLOB Fetch Error:', err)
    }

    // 5. Fallback: Jika CLOB gagal, coba Gamma API (opsional, tetapi rawan 404)
    // Kita skip Gamma jika CLOB gagal karena fokus pada balance
    
    return NextResponse.json({
      configured: true,
      balance: 0,
      stats: defaultPortfolio(),
      warning: 'Balance fetched from fallback (0)',
    })

  } catch (error: any) {
    console.error('[Portfolio API] Error:', error)
    return NextResponse.json({ 
      error: 'Internal Server Error', 
      details: error.message 
    }, { status: 500 })
  }
}

// Helper default portfolio jika semua gagal
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
