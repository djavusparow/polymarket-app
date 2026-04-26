// app/api/trade/heartbeat/route.ts
// FIX: Heartbeat endpoint Polymarket tidak membutuhkan body (cukup POST kosong dengan auth headers).
// FIX: Tidak perlu heartbeat_id di body — Polymarket menggunakan auth headers untuk identifikasi sesi.
// Referensi: https://docs.polymarket.com/api-reference/trade/send-heartbeat

import { NextResponse } from 'next/server'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'

/**
 * POST /api/trade/heartbeat
 *
 * Kirim heartbeat ke Polymarket CLOB agar order terbuka tidak di-cancel otomatis.
 * Harus dipanggil setiap ~5-10 detik saat auto-trading aktif.
 *
 * Polymarket CLOB akan cancel semua open orders jika heartbeat tidak diterima
 * dalam jangka waktu tertentu (biasanya ~30 detik).
 */
export async function POST(request: Request) {
  // Parse credentials dari body (opsional — env vars lebih diprioritaskan)
  let clientCreds: Partial<ClobCreds> | undefined
  try {
    const raw = await request.text()
    if (raw.trim()) clientCreds = JSON.parse(raw)
  } catch {
    // Ignore parse error — env vars akan digunakan
  }

  const creds = resolveCredentials(clientCreds)
  if (!creds) {
    return NextResponse.json({ error: 'No credentials configured' }, { status: 401 })
  }

  try {
    // Polymarket heartbeat endpoint: POST /heartbeats
    // Body kosong (empty string) — auth identity sudah ada di headers
    const path = '/heartbeats'
    const bodyStr = ''

    const headers = await buildClobHeaders(creds, 'POST', path, bodyStr)

    const res = await fetch(`${CLOB_HOST}${path}`, {
      method: 'POST',
      headers,
      // Tidak ada body — heartbeat hanya membutuhkan header auth yang valid
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[heartbeat] CLOB responded ${res.status}:`, text)
      return NextResponse.json(
        { error: `Heartbeat failed: ${text}`, status: res.status },
        { status: res.status }
      )
    }

    // Response bisa kosong atau JSON bergantung versi API
    let responseData: any = {}
    try {
      const text = await res.text()
      if (text.trim()) responseData = JSON.parse(text)
    } catch { /* ignore */ }

    return NextResponse.json({
      success:   true,
      timestamp: Date.now(),
      ...responseData,
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[heartbeat] Error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
