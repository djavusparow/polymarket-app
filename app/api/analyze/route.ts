import { NextResponse } from 'next/server'
import { analyzeMarket } from '@/lib/ai-engine'
import type { PolymarketMarket } from '@/lib/types'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const market: PolymarketMarket = body.market
    console.log('[api/analyze] Market:', market.question.slice(0, 50) + '...')

    if (!market || !market.question || !market.condition_id) {
      return NextResponse.json({ error: 'Invalid market data' }, { status: 400 })
    }

    const signal = await analyzeMarket(market)
    console.log('[api/analyze] Signal confidence:', signal.confidence, 'analyses:', signal.analyses.length)
    return NextResponse.json({ signal })
  } catch (e: unknown) {
    console.error('[api/analyze] error:', e)
    return NextResponse.json({ error: 'Analysis failed', details: e instanceof Error ? e.message : 'Unknown' }, { status: 500 })
  }
}
