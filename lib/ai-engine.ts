import type { PolymarketMarket, AIAnalysis, CombinedSignal, AIModel, SignalDirection } from './types'
import { parseOutcomePrice } from './polymarket'

// ─────────────────────────────────────────────────────────────────────────────
// 1. ENVIRONMENT VARIABLES
// ─────────────────────────────────────────────────────────────────────────────
// Pastikan variabel ini ada di Vercel Environment Variables:
// NEWSAPI_KEY, BLACKBOX_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY
const NEWS_API_KEY = process.env.NEWSAPI_KEY || ''
const BLACKBOX_API_KEY = process.env.BLACKBOX_API_KEY || ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''

// ─────────────────────────────────────────────────────────────────────────────
// 2. PROVIDERS CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
// Urutan provider menentukan prioritas: DeepSeek (1st), Blackbox (2nd), dll.
const LLM_PROVIDERS = [
  {
    name: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: DEEPSEEK_API_KEY
  },
  {
    name: 'blackbox',
    endpoint: 'https://llm.blackbox.ai/chat/completions',
    model: 'claude-3.5-sonnet', // Model default Blackbox yang stabil
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: BLACKBOX_API_KEY
  },
  {
    name: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: OPENAI_API_KEY
  },
  {
    name: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-70b-versatile', // Model Groq yang masih aktif (ganti jika error)
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: GROQ_API_KEY
  }
] as const

// ─────────────────────────────────────────────────────────────────────────────
// ─── PROMPTS (satu objek, dipakai oleh callLLM) ───────────────────────────────
const PROMPTS = {
  MARKET: `You are an expert prediction market analyst specializing in Polymarket.
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
}`,

  RISK: `You are a quantitative risk analyst for prediction market trading.
Your role is to evaluate market risks and provide risk‑adjusted trading signals.

For each market evaluate:
1. Uncertainty and variance in outcome probability
2. Tail risks and black swan events
3. Correlation with other market events
4. Bid‑ask spread and slippage costs
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
}`,

  SENTIMENT: `You are a sentiment and information analyst for prediction market trading.
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
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. NEWS FETCHING
// ─────────────────────────────────────────────────────────────────────────────
async function fetchNews(query: string): Promise<string> {
  if (!NEWS_API_KEY) return ''
  
  try {
    // Timeout 10 detik agar tidak menunggu terlalu lama
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&apiKey=${NEWS_API_KEY}`,
      { signal: controller.signal }
    )
    clearTimeout(timeoutId)

    if (!res.ok) return ''
    
    const data = await res.json()
    const recent = data.articles?.slice(0, 3)
      .map((a: any) => `- ${a.title} (${new Date(a.publishedAt).toLocaleDateString()})`)
      .join('\n') || ''
    
    return recent ? `\n\nRECENT NEWS:\n${recent}` : ''
  } catch {
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CALL LLM FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
async function callLLM(provider: typeof LLM_PROVIDERS[number], prompt: string, context: string): Promise<AIAnalysis | null> {
  if (!provider.key || provider.key.trim() === '') {
    console.error(`[callLLM] ${provider.name}: ❌ NO API KEY`)
    return null
  }

  console.log(`[callLLM] ${provider.name} → ${provider.model}`)
  
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 detik timeout

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [provider.keyHeader]: `${provider.keyPrefix}${provider.key}`
    }

    // Spesifik untuk Blackbox
    if (provider.name === 'blackbox') {
      headers['customerId'] = 'cus_UIDAXBwD6XwhtQ'
    }

    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: context }
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)

    // Cek response status
    if (!res.ok) {
      const errText = await res.text()
      console.error(`[${provider.name}] ❌ HTTP ${res.status}: ${errText.slice(0, 100)}...`)
      return null
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    
    // Bersihkan markdown (```json ... ```)
    const clean = content.replace(/```json?[\s\S]*?```/g, '').replace(/```/g, '').trim()
    
    let parsed: any
    try {
      parsed = JSON.parse(clean)
    } catch (parseErr) {
      console.error(`[${provider.name}] ❌ JSON Parse Error:`, clean.slice(0, 100))
      return null
    }

    // Validasi field wajib
    if (!parsed.signal || !['BUY', 'SELL', 'HOLD'].includes(parsed.signal)) {
      return null
    }
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100) {
      return null
    }

    console.log(`[${provider.name}] ✅ Success! Confidence: ${parsed.confidence}`)

    return {
      model: provider.name as AIModel,
      signal: parsed.signal as SignalDirection,
      confidence: parsed.confidence,
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

// ─────────────────────────────────────────────────────────────────────────────
// 6. ENSEMBLE LOGIC
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 7. MAIN ANALYSIS FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeMarket(market: PolymarketMarket): Promise<CombinedSignal> {
  const startTime = Date.now()
  console.log(`[analyzeMarket] Starting for: ${market.id}`)
  
  try {
    const yesPrice = parseOutcomePrice(market.outcomePrices)
    const baseContext = buildMarketContext(market)
    
    // 1. Fetch News
    const news = await fetchNews(market.question)
    const fullContext = news ? baseContext + news : baseContext

    // 2. Siapkan Provider (Hanya yang punya key)
    const activeProviders = LLM_PROVIDERS.filter(p => p.key && p.key.trim() !== '')
    
    if (activeProviders.length === 0) {
      console.error('[analyzeMarket] ❌ CRITICAL: No API keys configured in Vercel Env!')
      return getDefaultSignal(market, yesPrice)
    }

    console.log(`[analyzeMarket] Active providers: ${activeProviders.map(p => p.name).join(', ')}`)

    // 3. Jalankan 3 Analisis Paralel (Market, Risk, Sentiment)
    // Kita rotasi provider jika ada lebih dari 3, atau ulangi jika kurang dari 3
    const getProvider = (index: number) => activeProviders[index % activeProviders.length]
    
    const results = await Promise.all([
      callLLM(getProvider(0), PROMPTS.MARKET, fullContext),
      callLLM(getProvider(1), PROMPTS.RISK, fullContext),
      callLLM(getProvider(2), PROMPTS.SENTIMENT, fullContext)
    ])

    // 4. Gabungkan hasil
    const analyses = results.filter(Boolean) as AIAnalysis[]
    console.log(`[analyzeMarket] Completed in ${Date.now() - startTime}ms. Success: ${analyses.length}/${results.length}`)

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
  } catch (e) {
    console.error('[analyzeMarket] ERROR:', e)
    throw e
  }
}

// Helper untuk membangun context pasar
function buildMarketContext(market: PolymarketMarket): string {
  const yesPrice = parseOutcomePrice(market.outcomePrices)
  const volume = (market.volume24hr || 0).toLocaleString()
  return `MARKET: ${market.question}
CATEGORY: ${market.category || 'General'}
YES: ${(yesPrice * 100).toFixed(1)}% | NO: ${(100 - yesPrice * 100).toFixed(1)}%
VOL 24H: $${volume}
END: ${market.end_date_iso ? new Date(market.end_date_iso).toLocaleDateString() : 'TBD'}

Analyze and return JSON signal.`
}

// Helper default signal jika semua gagal
function getDefaultSignal(market: PolymarketMarket, yesPrice: number): CombinedSignal {
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

// ─────────────────────────────────────────────────────────────────────────────
// 8. BATCH ANALYSIS (Opsional)
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeMarketsBatch(markets: PolymarketMarket[]): Promise<CombinedSignal[]> {
  const signals: CombinedSignal[] = []
  const CONCURRENCY = 3 // Jalankan 3 market sekaligus
  let completed = 0

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(async (market) => {
      const signal = await analyzeMarket(market)
      completed++
      if (completed % 10 === 0) console.log(`Batch Progress: ${Math.round(completed / markets.length * 100)}%`)
      return signal
    }))

    signals.push(...batchResults)
    
    // Delay kecil untuk menghindari rate limit jika batch besar
    if (i + CONCURRENCY < markets.length) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence)
}
