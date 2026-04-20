import { NextResponse } from 'next/server'
import { analyzeMarket } from '@/lib/ai-engine'
import type { PolymarketMarket } from '@/lib/types'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const market: PolymarketMarket = body.market

    // Validate required fields
    if (!market || !market.question || !market.condition_id) {
      return NextResponse.json(
        { error: 'Invalid market data - missing required fields' },
        { status: 400 }
      )
    }

    const signal = await analyzeMarket(market)
    return NextResponse.json({ signal })
  } catch (e: unknown) {
    console.error('[api/analyze] error:', e)
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
  }
}
