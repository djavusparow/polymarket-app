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

    // --- STRATEGI CARI BALANCE ---
    // Karena Anda menggunakan Proxy Wallet (Signature Type 0 atau 1),
    // Endpoint yang paling aman adalah menanyakan balance berdasarkan funder address.

    let balance = 0
    let found = false

    // 1. Coba: /account/{funderAddress}/balances (Paling umum untuk Proxy)
    if (!found) {
      try {
        const path = `/account/${creds.funderAddress}/balances`
        const headers = await buildClobHeaders(creds, 'GET', path, '')
        const res = await fetch(`${CLOB_HOST}${path}`, { headers, cache: 'no-store' })
        
        if (res.ok) {
          const data = await res.json()
          // Respons biasanya: { "USDC": "150000000", ... }
          // USDC di Polymarket biasanya disimpan dalam satuan kecil (1e6)
          if (data.USDC) {
            balance = parseFloat(data.USDC) / 1e6
            found = true
            console.log(`[Portfolio API] Success via /account/{addr}/balances: ${balance}`)
          }
        } else {
          console.log(`[Portfolio API] Failed ${path}: ${res.status}`)
        }
      } catch (e) { console.error(e) }
    }

    // 2. Coba: /account/me/balances (Jika auth context auto-detect funder)
    if (!found) {
      try {
        const path = `/account/me/balances`
        const headers = await buildClobHeaders(creds, 'GET', path, '')
        const res = await fetch(`${CLOB_HOST}${path}`, { headers, cache: 'no-store' })
        
        if (res.ok) {
          const data = await res.json()
          if (data.USDC) {
            balance = parseFloat(data.USDC) / 1e6
            found = true
            console.log(`[Portfolio API] Success via /account/me/balances: ${balance}`)
          }
        }
      } catch (e) { console.error(e) }
    }

    // 3. Coba: /account/{funderAddress} (Info dasar akun)
    if (!found) {
      try {
        const path = `/account/${creds.funderAddress}`
        const headers = await buildClobHeaders(creds, 'GET', path, '')
        const res = await fetch(`${CLOB_HOST}${path}`, { headers, cache: 'no-store' })
        
        if (res.ok) {
          const data = await res.json()
          // Cek field yang mungkin ada
          if (data.balance) {
            balance = parseFloat(data.balance) / 1e6
            found = true
          } else if (data.availableBalance) {
            balance = parseFloat(data.availableBalance) / 1e6
            found = true
          }
        }
      } catch (e) { console.error(e) }
    }

    if (!found) {
      console.log("[Portfolio API] Could not fetch balance from CLOB. Defaulting to 0.")
      // Jika gagal total, kembalikan 0 atau coba fetch dari on-chain (lebih berat)
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

  } catch (error: any) {
    console.error('[Portfolio API] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
