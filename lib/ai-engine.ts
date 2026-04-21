import type { PolymarketMarket, AIAnalysis, CombinedSignal, AIModel, SignalDirection } from './types'
import { parseOutcomePrice } from './polymarket'

// Server env
const NEWS_API_KEY = process.env.NEWSAPI_KEY || ''
const BLACKBOX_API_KEY = process.env.BLACKBOX_API_KEY || ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const GROQ_API_KEY = process.env.GROQ_API_KEY || ''

const LLM_PROVIDERS = [
  { name: 'blackbox', endpoint: 'https://llm.blackbox.ai/chat/completions', model: 'claude-3.5-sonnet', keyHeader: 'Authorization', keyPrefix: 'Bearer ', key: BLACKBOX_API_KEY },
  { name: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', keyHeader: 'Authorization', keyPrefix: 'Bearer ', key: OPENAI_API_KEY },
  { name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama3-70b-8192', keyHeader: 'Authorization', keyPrefix: 'Bearer ', key: GROQ_API_KEY }
] as const

const PROMPTS = {
  MARKET: `Polymarket analyst. JSON only:
{"signal":"BUY|SELL|HOLD","confidence":0-100,"rationale":"...","true_probability_yes":0-1,"edge":-100-100,"target_price":0-1,"stop_loss_pct":0-50,"take_profit_pct":0-200}`,
  RISK: `Risk analyst. Same JSON.`,
  SENTIMENT: `Sentiment analyst. Same JSON.`
}

async function fetchNews(query: string): Promise<string> {
  if (!NEWS_API_KEY) return ''
  try {
    const res = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&apiKey=${NEWS_API_KEY}`)
    if (!res.ok) {
      console.warn('NewsAPI failed:', res.status)
      return ''
    }
    const data = await res.json()
    const recent = data.articles?.slice(0, 3).map((a: any) => `- ${a.title} (${new Date(a.publishedAt).toLocaleDateString()})`).join('\n') || ''
    return recent ? `\n\nRECENT NEWS:\n${recent}` : ''
  } catch (e) {
    console.warn('NewsAPI error:', e)
    return ''
  }
}

async function callLLM(provider: typeof LLM_PROVIDERS[number], prompt: string, context: string): Promise<AIAnalysis | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [provider.keyHeader]: `${provider.keyPrefix}${provider.key}`
    }
    if (provider.name === 'blackbox') headers.customerId = 'cus_UIDAXBwD6XwhtQ'

    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: context }],
        temperature: 0.3,
        max_tokens: 150,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) return null

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    const clean = content.replace(/```json?[\s\S]*?```/g, '').trim()
    const parsed = JSON.parse(clean)

    // Strict validation
    if (!['BUY', 'SELL', 'HOLD'].includes(parsed.signal as string)) return null
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100) return null
    if (typeof parsed.true_probability_yes !== 'number' || parsed.true_probability_yes < 0 || parsed.true_probability_yes > 1) return null

    return {
      model: provider.name as AIModel,
      signal: parsed.signal as SignalDirection,
      confidence: parsed.confidence as number,
      rationale: parsed.rationale as string || '',
      targetPrice: parsed.target_price as number || 0.5,
      stopLoss: parsed.stop_loss_pct as number || 20,
      takeProfit: parsed.take_profit_pct as number || 50,
      timestamp: Date.now()
    }
  } catch {
    clearTimeout(timeoutId)
    return null
  }
}

function buildMarketContext(market: PolymarketMarket): string {
  const yesPrice = parseOutcomePrice(market.outcomePrices)
  return `Polymarket market: ${market.question}
Category: ${market.category || 'General'}
Prices: YES ${(yesPrice * 100).toFixed(1)}% | NO ${(100 - yesPrice * 100).toFixed(1)}%
Volume 24h: $${(market.volume24hr || 0).toLocaleString()}
End date: ${market.end_date_iso ? new Date(market.end_date_iso).toLocaleDateString() : 'TBD'}
Give trading signal (JSON only).`
}

function ensemble(analyses: AIAnalysis[]): { direction: SignalDirection; confidence: number; recommendedSide: 'YES' | 'NO' } {
  const valid = analyses.filter(a => a.confidence > 0)
  if (!valid.length) return { direction: 'HOLD', confidence: 0, recommendedSide: 'YES' }

  const buyScore = valid.filter(a => a.signal === 'BUY').reduce((sum, a) => sum + a.confidence, 0)
  const sellScore = valid.filter(a => a.signal === 'SELL').reduce((sum, a) => sum + a.confidence, 0)
  const totalScore = buyScore + sellScore
  const avgConf = valid.reduce((sum, a) => sum + a.confidence, 0) / valid.length

  if (buyScore > sellScore && buyScore / totalScore > 0.4) {
    return { direction: 'BUY', confidence: Math.round((buyScore / totalScore) * avgConf), recommendedSide: 'YES' }
  }
  if (sellScore > buyScore && sellScore / totalScore > 0.4) {
    return { direction: 'SELL', confidence: Math.round((sellScore / totalScore) * avgConf), recommendedSide: 'NO' }
  }
  return { direction: 'HOLD', confidence: Math.round(avgConf * 0.5), recommendedSide: 'YES' }
}

export async function analyzeMarket(market: PolymarketMarket): Promise<CombinedSignal> {
  const context = buildMarketContext(market)
  const yesPrice = parseOutcomePrice(market.outcomePrices)

  const providers = LLM_PROVIDERS.filter(p => p.key).sort(() => Math.random() - 0.5) // Random order
  const results = await Promise.all([
    callLLM(providers[0] || LLM_PROVIDERS[0], PROMPTS.MARKET, context),
    callLLM(providers[1] || LLM_PROVIDERS[1], PROMPTS.RISK, context),
    callLLM(providers[2] || LLM_PROVIDERS[2], PROMPTS.SENTIMENT, context)
  ])

  const analyses = results.filter(Boolean) as AIAnalysis[]
  const ensembleResult = ensemble(analyses)

  return {
    market_id: market.id,
    question: market.question,
    direction: ensembleResult.direction,
    confidence: ensembleResult.confidence,
    analyses,
    yesPrice,
    noPrice: 1 - yesPrice,
    recommendedSide: ensembleResult.recommendedSide,
    timestamp: Date.now()
  }
}

export async function analyzeMarketsBatch(markets: PolymarketMarket[]): Promise<CombinedSignal[]> {
  const signals: CombinedSignal[] = []
  const CONCURRENCY = 3

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(async (market, batchIdx) => {
      const signal = await analyzeMarket(market)
      if (batchIdx % 10 === 0) console.log(`Progress: ${Math.round((i + batchIdx + 1) / markets.length * 100)}%`)
      return signal
    }))

    signals.push(...batchResults.filter(Boolean))
    
    if (i + CONCURRENCY < markets.length) {
      await new Promise(r => setTimeout(r, 1000)) // Rate limit backoff
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence)
}

