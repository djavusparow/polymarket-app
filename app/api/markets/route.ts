import { NextResponse } from 'next/server'
import { serverFetchTopMarkets, serverFetchMarkets } from '@/lib/polymarket'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') ?? 'active'
  const limit = parseInt(searchParams.get('limit') ?? '30', 10)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

  try {
    let markets
    if (type === 'top') {
      markets = await serverFetchTopMarkets()
    } else {
      markets = await serverFetchMarkets(limit)
    }
    return NextResponse.json({ markets, total: markets.length })
  } catch (e: unknown) {
    console.error('[api/markets] error:', e)
    return NextResponse.json({ error: 'Failed to fetch markets', markets: [] }, { status: 500 })
  }
}
