import type { PolymarketMarket, AIAnalysis, CombinedSignal, AIModel, SignalDirection } from './types'
import { parseOutcomePrice } from './polymarket'

const LLM_ENDPOINT = 'https://llm.blackbox.ai/chat/completions'
const LLM_HEADERS = {
  'customerId': 'cus_UIDAXBwD6XwhtQ',
  'Content-Type': 'application/json',
  'Authorization': 'Bearer xxx',
}

// ─── System Prompts per AI Role ───────────────────────────────────────────────

const MARKET_ANALYST_PROMPT = `You are an expert prediction market analyst specializing in Polymarket.
Your role is to analyze binary outcome markets and provide trading signals.

For each market you analyze, consider:
1. Base rates and historical frequencies for similar events
2. Current market price vs your estimated true probability
3. Volume and liquidity signals
4. Time remaining until resolution
5. Recent news and information signals
6. Market inefficiencies and mispricing

Respond ONLY with valid JSON in this exact format (no markdown, no extra text):
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <number 0-100>,
  "rationale": "<2-3 sentence explanation>",
  "true_probability_yes": <number 0-1>,
  "edge": <number -100 to 100>,
  "target_price": <number 0-1>,
  "stop_loss_pct": <number 0-50>,
  "take_profit_pct": <number 0-200>
}`

const RISK_ANALYST_PROMPT = `You are a quantitative risk analyst for prediction market trading.
Your role is to evaluate market risks and provide risk-adjusted trading signals.

For each market evaluate:
1. Uncertainty and variance in outcome probability
2. Tail risks and black swan events
3. Correlation with other market events
4. Bid-ask spread and slippage costs
5. Position sizing based on Kelly criterion
6. Maximum drawdown risk

Respond ONLY with valid JSON in this exact format:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <number 0-100>,
  "rationale": "<2-3 sentence risk assessment>",
  "true_probability_yes": <number 0-1>,
  "edge": <number -100 to 100>,
  "target_price": <number 0-1>,
  "stop_loss_pct": <number 0-50>,
  "take_profit_pct": <number 0-200>
}`

const SENTIMENT_ANALYST_PROMPT = `You are a sentiment and information analyst for prediction market trading.
Your role is to assess information flow, sentiment, and market momentum.

For each market analyze:
1. Information efficiency of current market price
2. Recency bias in market pricing
3. Crowd wisdom vs expert judgment signals
4. Recent developments and news catalysts
5. Social sentiment and narrative strength
6. Momentum and price trend signals

Respond ONLY with valid JSON in this exact format:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <number 0-100>,
  "rationale": "<2-3 sentence sentiment analysis>",
  "true_probability_yes": <number 0-1>,
  "edge": <number -100 to 100>,
  "target_price": <number 0-1>,
  "stop_loss_pct": <number 0-50>,
  "take_profit_pct": <number 0-200>
}`

// ─── Individual AI Analysis ───────────────────────────────────────────────────

async function callAI(
  systemPrompt: string,
  marketContext: string,
  model = 'openrouter/claude-sonnet-4'
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: LLM_HEADERS,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: marketContext },
        ],
        temperature: 0.3,
        max_tokens: 512,
      }),
    })
    if (!res.ok) {
      console.error('[ai-engine] API error:', res.status)
      return null
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    // Strip markdown code fences if present
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(clean)
  } catch (e) {
    console.error('[ai-engine] callAI error:', e)
    return null
  }
}

function buildMarketContext(market: PolymarketMarket): string {
  const yesPrice = parseOutcomePrice(market.outcomePrices)
  const noPrice = yesPrice > 0 ? (1 - yesPrice) : 0
  const endDate = market.end_date_iso
    ? new Date(market.end_date_iso).toLocaleDateString()
    : 'Unknown'
  const daysLeft = market.end_date_iso
    ? Math.max(0, Math.ceil((new Date(market.end_date_iso).getTime() - Date.now()) / 86400000))
    : null

  return `
MARKET ANALYSIS REQUEST
=======================
Question: ${market.question}
Description: ${market.description ?? 'N/A'}
Category: ${market.category ?? 'General'}

Current Prices:
- YES: ${(yesPrice * 100).toFixed(1)}¢ (implied probability: ${(yesPrice * 100).toFixed(1)}%)
- NO: ${(noPrice * 100).toFixed(1)}¢ (implied probability: ${(noPrice * 100).toFixed(1)}%)

Market Stats:
- Volume (24h): $${(market.volume24hr ?? 0).toLocaleString()}
- Total Volume: $${(market.volume ?? 0).toLocaleString()}
- Liquidity: $${(market.liquidity ?? 0).toLocaleString()}
- Best Bid: ${market.best_bid ?? 'N/A'}
- Best Ask: ${market.best_ask ?? 'N/A'}
- Resolution Date: ${endDate}${daysLeft !== null ? ` (${daysLeft} days remaining)` : ''}

Your task: Analyze this prediction market and provide a trading signal.
BUY signal = buy YES tokens (you believe YES probability > current price)
SELL signal = buy NO tokens (you believe YES probability < current price)
HOLD signal = market is fairly priced or insufficient edge
`.trim()
}

// ─── Ensemble Signal Combiner ─────────────────────────────────────────────────

function combineAnalyses(
  analyses: AIAnalysis[],
  market: PolymarketMarket
): { direction: SignalDirection; confidence: number; recommendedSide: 'YES' | 'NO' } {
  const valid = analyses.filter(a => a.confidence > 0)
  if (valid.length === 0) return { direction: 'HOLD', confidence: 0, recommendedSide: 'YES' }

  // Weighted vote — higher confidence = more weight
  let buyWeight = 0
  let sellWeight = 0
  let holdWeight = 0
  let totalWeight = 0

  for (const a of valid) {
    const w = a.confidence
    totalWeight += w
    if (a.signal === 'BUY') buyWeight += w
    else if (a.signal === 'SELL') sellWeight += w
    else holdWeight += w
  }

  const buyPct = totalWeight > 0 ? (buyWeight / totalWeight) * 100 : 0
  const sellPct = totalWeight > 0 ? (sellWeight / totalWeight) * 100 : 0
  const avgConfidence = totalWeight / valid.length

  let direction: SignalDirection = 'HOLD'
  let confidence = 0
  let recommendedSide: 'YES' | 'NO' = 'YES'

  if (buyPct > sellPct && buyPct > 40) {
    direction = 'BUY'
    confidence = Math.round((buyPct / 100) * avgConfidence)
    recommendedSide = 'YES'
  } else if (sellPct > buyPct && sellPct > 40) {
    direction = 'SELL'
    confidence = Math.round((sellPct / 100) * avgConfidence)
    recommendedSide = 'NO'
  } else {
    direction = 'HOLD'
    confidence = Math.round(avgConfidence * 0.5)
    recommendedSide = 'YES'
  }

  return { direction, confidence, recommendedSide }
}

// ─── Main Analysis Function ───────────────────────────────────────────────────

export async function analyzeMarket(market: PolymarketMarket): Promise<CombinedSignal> {
  const context = buildMarketContext(market)
  const yesPrice = parseOutcomePrice(market.outcomePrices)
  const noPrice = yesPrice > 0 ? 1 - yesPrice : 0

  // Run 3 AI analysts in parallel
  const [analystResult, riskResult, sentimentResult] = await Promise.all([
    callAI(MARKET_ANALYST_PROMPT, context),
    callAI(RISK_ANALYST_PROMPT, context),
    callAI(SENTIMENT_ANALYST_PROMPT, context),
  ])

  // All 3 calls use openrouter/claude-sonnet-4 via the unified endpoint.
  // Each is assigned a distinct role label so the UI shows which "analyst" produced it.
  const modelResults: Array<{ raw: Record<string, unknown> | null; model: AIModel }> = [
    { raw: analystResult,   model: 'claude-sonnet' },  // Market Analyst role
    { raw: riskResult,      model: 'claude-sonnet' },  // Risk Analyst role
    { raw: sentimentResult, model: 'claude-sonnet' },  // Sentiment Analyst role
  ]

  const analyses: AIAnalysis[] = modelResults
    .filter(r => r.raw !== null)
    .map(r => ({
      model: r.model,
      signal: (r.raw!.signal as SignalDirection) ?? 'HOLD',
      confidence: Number(r.raw!.confidence ?? 50),
      rationale: String(r.raw!.rationale ?? ''),
      targetPrice: Number(r.raw!.target_price ?? yesPrice),
      stopLoss: Number(r.raw!.stop_loss_pct ?? 20),
      takeProfit: Number(r.raw!.take_profit_pct ?? 50),
      timestamp: Date.now(),
    }))

  const { direction, confidence, recommendedSide } = combineAnalyses(analyses, market)

  return {
    market_id: market.id,
    question: market.question,
    direction,
    confidence,
    analyses,
    yesPrice,
    noPrice,
    recommendedSide,
    timestamp: Date.now(),
  }
}

// ─── Batch Analysis ───────────────────────────────────────────────────────────

export async function analyzeMarketsBatch(
  markets: PolymarketMarket[],
  onProgress?: (done: number, total: number) => void
): Promise<CombinedSignal[]> {
  const signals: CombinedSignal[] = []
  const CONCURRENCY = 3

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(m => analyzeMarket(m)))
    signals.push(...results)
    onProgress?.(Math.min(i + CONCURRENCY, markets.length), markets.length)
    // Small delay to avoid rate limits
    if (i + CONCURRENCY < markets.length) {
      await new Promise(r => setTimeout(r, 800))
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence)
}
