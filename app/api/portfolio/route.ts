import { NextRequest, NextResponse } from 'next/server'

// Konfigurasi Endpoint Polymarket
const POLYMARKET_API_BASE = 'https://clob.polymarket.com'

async function fetchPolymarketBalance(creds: {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  funderAddress: string
}) {
  const { apiKey, apiSecret, apiPassphrase, funderAddress } = creds

  // 1. Siapkan Tanda Tangan (Signature) untuk Authenticasi
  // Polymarket CLOB memerlukan tanda tangan untuk setiap request
  // Kita akan gunakan library `siwe` (Sign-In With Ethereum) atau manual signing
  // Namun, karena ini server-side, kita butuh private key atau menggunakan OAuth.
  
  // CATATAN PENTING:
  // Jika Anda menggunakan API Key standar Polymarket (bukan OAuth), 
  // biasanya Anda perlu melakukan request awal untuk mendapatkan token session.
  // Namun, Polymarket CLOB sering menggunakan signing message untuk auth.
  
  // SOLUSI SEDERHANA (Menggunakan API Key header):
  // Polymarket有时候 mengizinkan auth via header `X-API-KEY` (tergantung tipe API key)
  // Coba kita gunakan header standar dulu.
  
  try {
    // Endpoint untuk mendapatkan informasi akun (termasuk balance)
    // Sesuai dokumentasi Polymarket CLOB
    const url = `${POLYMARKET_API_BASE}/account/${funderAddress}`
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // Coba gunakan API Key langsung jika support
        'X-API-KEY': apiKey,
        // Jika perlu signature, tambahkan header disini (bisa menggunakan library `eccrypto` atau `ethers`)
      },
    })

    if (!response.ok) {
      throw new Error(`Polymarket API Error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    
    // Polymarket biasanya mengembalikan data dalam format:
    // { "address": "...", "balance": "...", "positions": [...] }
    // Atau mungkin perlu di-parse dari field specific.
    
    // Contoh parsing dummy (sesuaikan dengan response JSON asli dari Polymarket)
    // Jika API mengembalikan string balance, pastikan di-parse ke number
    const balanceRaw = data.balance || data.availableBalance || data.walletBalance || 0
    
    return {
      balance: parseFloat(balanceRaw),
      raw: data
    }
  } catch (error) {
    console.error('Error fetching Polymarket balance:', error)
    throw error
  }
}

export async function GET(request: NextRequest) {
  try {
    const credsHeader = request.headers.get('X-Clob-Creds')
    
    if (!credsHeader) {
      return NextResponse.json({ configured: false, error: 'No credentials' }, { status: 400 })
    }

    const creds = JSON.parse(credsHeader)

    // Panggil fungsi untuk mengambil balance asli
    const { balance, raw } = await fetchPolymarketBalance(creds)

    // Siapkan stats
    const stats = {
      total_balance: balance,
      available_balance: balance,
      total_value: balance, 
      total_pnl: 0, // Anda perlu logika terpisah untuk PnL dari posisi terbuka
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
      raw: raw, // Kirim data mentah untuk debug
      timestamp: new Date().toISOString(),
    })

  } catch (error: any) {
    console.error('[Portfolio API] Error:', error.message)
    
    // Jika gagal connect ke Polymarket, kembalikan error detail
    return NextResponse.json({ 
      error: 'Failed to fetch from Polymarket', 
      details: error.message 
    }, { status: 500 })
  }
}
