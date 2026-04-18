import { NextResponse } from 'next/server'
import { fetchMidpointPrices, fetchLastTradePrices } from '@/lib/polymarket'

/**
 * GET /api/prices?tokens=tokenId1,tokenId2,...
 *
 * Fetches real-time midpoint and last trade prices for given token IDs
 * from the Polymarket CLOB (public, no auth required).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const tokenParam = searchParams.get('tokens') ?? ''
  const tokenIds = tokenParam.split(',').map(t => t.trim()).filter(Boolean)

  if (tokenIds.length === 0) {
    return NextResponse.json({ error: 'No token IDs provided' }, { status: 400 })
  }

  try {
    const [midpoints, lastTrades] = await Promise.all([
      fetchMidpointPrices(tokenIds),
      fetchLastTradePrices(tokenIds),
    ])

    const prices: Record<string, { mid: number; last: number }> = {}
    for (const id of tokenIds) {
      prices[id] = {
        mid:  midpoints[id]  ?? 0,
        last: lastTrades[id] ?? midpoints[id] ?? 0,
      }
    }

    return NextResponse.json({ prices, timestamp: Date.now() })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
