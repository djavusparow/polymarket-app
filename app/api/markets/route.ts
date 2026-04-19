import { NextResponse } from 'next/server'
import { serverFetchTopMarkets, serverFetchMarkets } from '@/lib/polymarket'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') ?? 'active'
  
  // Enforce maximum limit of 100 to prevent resource abuse
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '30', 10), 100)
  // Note: Offset is removed as Polymarket API uses keyset pagination (cursor-based)

  try {
    let markets
    if (type === 'top') {
      markets = await serverFetchTopMarkets()
    } else {
      // serverFetchMarkets accepts only 'limit', not 'offset'
      markets = await serverFetchMarkets(limit)
    }
    
    return NextResponse.json({ markets, total: markets.length })
  } catch (e: unknown) {
    console.error('[api/markets] error:', e)
    return NextResponse.json({ error: 'Failed to fetch markets', markets: [] }, { status: 500 })
  }
}
