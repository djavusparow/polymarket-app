import type { PolymarketMarket, AIAnalysis, CombinedSignal, AIModel, SignalDirection } from './types'
import { parseOutcomePrice } from './polymarket'

// Server env (secure)
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
  MARKET: `Expert Polymarket analyst. JSON only:
{"signal":"BUY|SELL|HOLD","confidence":0-100,"rationale":"brief","true_probability_yes":0-1,"edge":-100-100,"target_price":0-1,"stop_loss_pct":0-50,"take_profit_pct":0-200}`,
  RISK: `Risk analyst. Same JSON format.`,
  SENTIMENT: `Sentiment analyst. Same JSON.`
}

async function fetchNews(query: string): Promise<string> {
  if (!NEWS_API_KEY) {
    console.warn('NewsAPI key missing')
    return ''
  }
  try {
    const res = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&apiKey=${NEWS_API_KEY}`)
    if (!res.ok) {
      console.warn(`NewsAPI ${res.status}: ${res.statusText}`)
      return ''
    }
    const data = await res.json()
    const recent = data.articles?.slice(0, 3).map((a: any) => `- ${a.title} (${new Date(a.publishedAt).toLocaleDateString()})`).join('\n') || ''
    return recent ? `\n\nRECENT NEWS:\n${recent}` : ''
  } catch (e) {
    console.warn('NewsAPI fetch error:', e)
    return ''
  }
}

async function callLLM(provider: typeof LLM_PROVIDERS[number], prompt: string, context: string): Promise<AIAnalysis | null> {
  console.log(`[callLLM] Calling ${provider.name}`)
  console.log(`[callLLM] Provider key exists: ${!!provider.key}`)
  
  if (!provider.key || provider.key.trim() === '') {
    console.error(`[callLLM] ${provider.name}: ❌ NO API KEY`)
    return null
  }
  
  console.log(`[callLLM] ${provider.name}: ✅ Has API key`)
  
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [provider.keyHeader]: `${provider.keyPrefix}${provider.key}`
    }
    if (provider.name === 'blackbox') headers.customerId = 'cus_UIDAXBwD6XwhtQ'

    console.log(`[callLLM] ${provider.name} 🚀 Sending request to ${provider.endpoint}`)

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

    console.log(`[callLLM] ${provider.name} Response status: ${res.status}`)

    if (!res.ok) {
      const errText = await res.text()
      console.error(`[${provider.name}] ❌ HTTP ${res.status}: ${errText.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    const clean = content.replace(/```json?[\s\S]*?```/g, '').trim()
    
    let parsed: any
    try {
      parsed = JSON.parse(clean)
    } catch (parseErr) {
      console.error(`[${provider.name}] ❌ JSON Parse Error:`, clean.slice(0, 100))
      return null
    }

    const signal = parsed.signal as string
    if (!['BUY', 'SELL', 'HOLD'].includes(signal)) {
      console.error(`[${provider.name}] ❌ Invalid signal: ${signal}`)
      return null
    }
    const confidence = Number(parsed.confidence)
    if (isNaN(confidence) || confidence < 0 || confidence > 100) {
      console.error(`[${provider.name}] ❌ Invalid confidence: ${confidence}`)
      return null
    }
    const prob = Number(parsed.true_probability_yes)
    if (isNaN(prob) || prob < 0 || prob > 1) {
      console.error(`[${provider.name}] ❌ Invalid prob: ${prob}`)
      return null
    }

    console.log(`[${provider.name}] ✅ Success! Confidence: ${confidence}`)

    return {
      model: provider.name as AIModel,
      signal: signal as SignalDirection,
      confidence,
      rationale: String(parsed.rationale || ''),
      targetPrice: Number(parsed.target_price) || 0.5,
      stopLoss: Number(parsed.stop_loss_pct) || 20,
      takeProfit: Number(parsed.take_profit_pct) || 50,
      timestamp: Date.now()
    }
  } catch (e) {
    clearTimeout(timeoutId)
    console.error(`[${provider.name}] ❌ Error:`, e)
    return null
  }
}

function buildMarketContext(market: PolymarketMarket): string {
  const yesPrice = parseOutcomePrice(market.outcomePrices)
  const volume = (market.volume24hr || 0).toLocaleString()
  return `MARKET: ${market.question}
CAT: ${market.category || 'General'}
YES: ${(yesPrice * 100).toFixed(1)}% | NO: ${(100 - yesPrice * 100).toFixed(1)}%
VOL24: $${volume}
END: ${market.end_date_iso ? new Date(market.end_date_iso).toLocaleDateString() : 'TBD'}

JSON trading signal.`
}

function ensemble(analyses: AIAnalysis[]): { direction: SignalDirection; confidence: number; recommendedSide: 'YES' | 'NO' } {
  const valid = analyses.filter(a => a.confidence > 0)
  if (!valid.length) return { direction: 'HOLD', confidence: 0, recommendedSide: 'YES' }

  const buyScore = valid.filter(a => a.signal === 'BUY').reduce((sum, a) => sum + a.confidence, 0)
  const sellScore = valid.filter(a => a.signal === 'SELL').reduce((sum, a) => sum + a.confidence, 0)
  const totalScore = buyScore + sellScore
  const avgConf = valid.reduce((sum, a) => sum + a.confidence, 0) / valid.length

  if (totalScore === 0) {
    return { direction: 'HOLD', confidence: Math.round(avgConf * 0.5), recommendedSide: 'YES' }
  }

  if (buyScore > sellScore && buyScore / totalScore > 0.4) {
    return { direction: 'BUY', confidence: Math.round((buyScore / totalScore) * avgConf), recommendedSide: 'YES' }
  }
  if (sellScore > buyScore && sellScore / totalScore > 0.4) {
    return { direction: 'SELL', confidence: Math.round((sellScore / totalScore) * avgConf), recommendedSide: 'NO' }
  }
  return { direction: 'HOLD', confidence: Math.round(avgConf * 0.5), recommendedSide: 'YES' }
}

export async function analyzeMarket(market: PolymarketMarket): Promise<CombinedSignal> {
  console.log(`[analyzeMarket] Starting for: ${market.id || market.question.slice(0, 30)}`)
  
  try {
    const baseContext = buildMarketContext(market)
    console.log('[analyzeMarket] Context built')
    
    const news = await fetchNews(market.question)
    console.log('[analyzeMarket] News:', news.length > 0 ? 'OK' : 'Empty')
    
    const fullContext = news ? baseContext + news : baseContext
    
    // DEBUG: Lihat semua provider dan key-nya
    console.log('[analyzeMarket] All providers:', LLM_PROVIDERS.map(p => `${p.name}: ${p.key ? '✅' : '❌'}`))
    
    const providers = LLM_PROVIDERS.filter(p => p.key).sort(() => Math.random() - 0.5).slice(0, 3)
    console.log('[analyzeMarket] Active providers:', providers.map(p => p.name))
    
    if (providers.length === 0) {
      console.error('[analyzeMarket] ❌ ERROR: No providers with valid keys!')
      const yesPrice = parseOutcomePrice(market.outcomePrices)
      return {
        market_id: market.id,
        question: market.question,
        direction: 'HOLD',
        confidence: 0,
        analyses: [],
        yesPrice,
        noPrice: 1 - yesPrice,
        recommendedSide: 'YES',
        timestamp: Date.now()
      }
    }
    
    console.log('[analyzeMarket] Calling LLMs...')
    const results = await Promise.all([
      callLLM(providers[0], PROMPTS.MARKET, fullContext),
      callLLM(providers[1], PROMPTS.RISK, fullContext),
      callLLM(providers[2], PROMPTS.SENTIMENT, fullContext)
    ])
    
    console.log('[analyzeMarket] LLM Results:', results.map((r, i) => `[${i}]: ${r ? '✅' : '❌'}`))
    
    const analyses = results.filter(Boolean) as AIAnalysis[]
    console.log('[analyzeMarket] Successful analyses:', analyses.length)
    
    const ensembleResult = ensemble(analyses)
    const yesPrice = parseOutcomePrice(market.outcomePrices)
    
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
  } catch (e) {
    console.error('[analyzeMarket] ERROR:', e)
    throw e
  }
}

export async function analyzeMarketsBatch(markets: PolymarketMarket[]): Promise<CombinedSignal[]> {
  const signals: CombinedSignal[] = []
  const CONCURRENCY = 3
  let completed = 0

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(async (market) => {
      const signal = await analyzeMarket(market)
      completed++
      if (completed % 10 === 0) console.log(`AI Progress: ${Math.round(completed / markets.length * 100)}%`)
      return signal
    }))

    signals.push(...batchResults)
    
    if (i + CONCURRENCY < markets.length) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence)
}
