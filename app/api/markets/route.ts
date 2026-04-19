import { NextResponse } from 'next/server'
import { serverFetchTopMarkets, serverFetchMarkets } from '@/lib/polymarket'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') ?? 'active'
  
  // Enforce maximum limit of 100 to prevent resource abuse
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '30', 10), 100)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

  try {
    let markets
    if (type === 'top') {
      markets = await serverFetchTopMarkets()
    } else {
      // Pass offset for complete pagination support
      markets = await serverFetchMarkets(limit, offset)
    }
    
    return NextResponse.json({ markets, total: markets.length })
  } catch (e: unknown) {
    console.error('[api/markets] error:', e)
    return NextResponse.json({ error: 'Failed to fetch markets', markets: [] }, { status: 500 })
  }
}
