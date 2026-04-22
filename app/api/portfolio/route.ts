// app/api/portfolio/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'

export async function GET(request: NextRequest) {
  try {
    const credsHeader = request.headers.get('X-Clob-Creds')
    let clientCreds: Partial<ClobCreds> | undefined
    if (credsHeader) {
      try { clientCreds = JSON.parse(credsHeader) } catch { /* ignore */ }
    }

    const creds = resolveCredentials(clientCreds)
    if (!creds || !creds.funderAddress) {
      return NextResponse.json({ configured: false, error: 'No credentials' }, { status: 400 })
    }

    console.log(`[Portfolio API] Fetching balance for ${creds.funderAddress} (Type: ${creds.signatureType})`)

    // --- MENCOBA ENDPOINT ACCOUNT ME ---
    // Endpoint ini mengembalikan data akun pribadi berdasarkan API Key yang digunakan
    const path = '/account/me'
    const headers = await buildClobHeaders(creds, 'GET', path, '')
    
    const res = await fetch(`${CLOB_HOST}${path}`, {
      method: 'GET',
      headers: headers,
      cache: 'no-store'
    })

    if (!res.ok) {
      console.log(`[Portfolio API] Failed ${path}: ${res.status} ${res.statusText}`)
      // Jika /account/me gagal, coba fallback ke /account
      const fallbackPath = '/account'
      const fallbackHeaders = await buildClobHeaders(creds, 'GET', fallbackPath, '')
      const fallbackRes = await fetch(`${CLOB_HOST}${fallbackPath}`, {
        method: 'GET',
        headers: fallbackHeaders,
        cache: 'no-store'
      })

      if (!fallbackRes.ok) {
        console.log(`[Portfolio API] Failed ${fallbackPath}: ${fallbackRes.status} ${fallbackRes.statusText}`)
        return NextResponse.json({
          configured: true,
          balance: 0,
          stats: defaultPortfolio(),
          warning: 'Balance service unavailable',
        })
      }
      
      // Proses data dari /account
      const data = await fallbackRes.json()
      const balance = processBalance(data)
      return generateResponse(balance)
    }

    // Proses data dari /account/me
    const data = await res.json()
    const balance = processBalance(data)
    
    return generateResponse(balance)

  } catch (error: any) {
    console.error('[Portfolio API] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// Helper untuk mengambil balance dari data respons
function processBalance(data: any): number {
  // Polymarket biasanya menyimpan USDC dalam satuan kecil (1e6)
  // Coba cari field 'balance' atau 'availableBalance'
  let balanceStr = '0'
  
  if (data.balance) {
    balanceStr = data.balance
  } else if (data.availableBalance) {
    balanceStr = data.availableBalance
  } else if (data.cash) {
    balanceStr = data.cash
  } else if (data.walletBalance) {
    balanceStr = data.walletBalance
  }

  // Konversi dari string/number ke float, lalu bagi 1e6 (USDC decimals)
  let balance = parseFloat(balanceStr)
  if (balance > 1000000) { // Jika nilai sangat besar, asumsikan dalam satuan kecil
    balance = balance / 1e6
  }
  
  return balance
}

// Helper untuk generate response JSON
function generateResponse(balance: number) {
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
