import type { PolymarketMarket, AIAnalysis, CombinedSignal, AIModel, SignalDirection } from './types'
import { parseOutcomePrice } from './polymarket'

// ─────────────────────────────────────────────────────────────────────────────
// 1. ENVIRONMENT VARIABLES
// ─────────────────────────────────────────────────────────────────────────────
const NEWS_API_KEY = process.env.NEWSAPI_KEY || ''
const BLACKBOX_API_KEY = process.env.BLACKBOX_API_KEY || ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''

// ─────────────────────────────────────────────────────────────────────────────
// 2. PROVIDERS CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
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
    // Menggunakan endpoint chat resmi Blackbox
    endpoint: 'https://llm.blackbox.ai/chat/completions',
    // Model default Blackbox yang stabil
    model: 'claude-3.5-sonnet', 
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
    model: 'llama-3.1-8b-instant', 
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: GROQ_API_KEY
  }
] as const

// ─────────────────────────────────────────────────────────────────────────────
// 3. PROMPTS
// ─────────────────────────────────────────────────────────────────────────────
const PROMPTS = {
  MARKET: `You are an expert prediction market analyst specializing in Polymarket.
Your role is to analyze binary outcome markets and provide trading signals.
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
Your role is to evaluate market risks and provide risk-adjusted trading signals.
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
}`,

  // Prompt khusus untuk analisis berita NewsAPI (seperti yang Anda minta)
  NEWS_ANALYST: `You are a news analyst for prediction markets.
Your role is to analyze recent news headlines and assess their impact on the market outcome.
Respond ONLY with valid JSON in this exact format:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <number 0-100>,
  "rationale": "<2-3 sentence explanation based on news>",
  "true_probability_yes": <number 0-1>,
  "edge": <number -100 to 100>,
  "target_price": <number 0-1>,
  "stop_loss_pct": <number 0-50>,
  "take_profit_pct": <number 0-200>
}`
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. NEWS FETCHING (NEWSAPI INTEGRATION)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchNews(query: string): Promise<string> {
  if (!NEWS_API_KEY) return ''
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    // Mengambil berita terbaru untuk query pasar
    const res = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&pageSize=5&apiKey=${NEWS_API_KEY}`,
      { signal: controller.signal }
    )
    clearTimeout(timeoutId)

    if (!res.ok) return ''
    
    const data = await res.json()
    if (!data.articles || data.articles.length === 0) return ''

    // Format berita menjadi string ringkas
    const recent = data.articles
      .slice(0, 3)
      .map((a: any) => `- ${a.title} (Source: ${a.source?.name || 'Unknown'})`)
      .join('\n')
    
    return `\n\nLATEST NEWS:\n${recent}`
  } catch (e) {
    console.warn('[NewsAPI] Fetch error:', e)
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CALL LLM FUNCTION (DENGAN PERBAIKAN DEEPSEEK & BLACKBOX)
// ─────────────────────────────────────────────────────────────────────────────
async function callLLM(provider: typeof LLM_PROVIDERS[number], prompt: string, context: string): Promise<AIAnalysis | null> {
  if (!provider.key || provider.key.trim() === '') {
    // Jangan log error karena mungkin ini memang provider yang tidak di-set
    return null
  }

  console.log(`[callLLM] ${provider.name} → ${provider.model}`)
  
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45000) // Timeout 45 detik

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [provider.keyHeader]: `${provider.keyPrefix}${provider.key}`
    }

    // Spesifik untuk Blackbox (customerId opsional, tapi jika ada error 402, coba tanpa ini)
    if (provider.name === 'blackbox') {
      // Hapus baris ini jika Anda yakin key Anda adalah key produksi langsung
      // headers['customerId'] = 'cus_UIDAXBwD6XwhtQ' 
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
      // Log ringkas saja, jangan panic
      console.error(`[${provider.name}] ❌ HTTP ${res.status}: ${errText.slice(0, 100)}...`)
      return null
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    
    // PERBAIKAN UTAMA UNTUK DEEPSEEK:
    // Deepseek sering mengirim teks pembuka sebelum JSON. 
    // Kita gunakan regex yang lebih kuat untuk ekstrak JSON.
    let clean = content.trim()
    
    // Coba cari blok JSON yang diapit ```
    const jsonBlockMatch = clean.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      clean = jsonBlockMatch[1];
    } else {
      // Coba cari blok JSON tanpa label
      const blockMatch = clean.match(/```([\s\S]*?)```/);
      if (blockMatch) {
        clean = blockMatch[1];
      } else {
        // Jika tidak ada ```, coba cari objek JSON mulai dari { pertama hingga } terakhir
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
          clean = clean.substring(start, end + 1);
        }
      }
    }
    
    // Bersihkan sisa karakter aneh
    clean = clean.replace(/\n/g, '').replace(/\r/g, '').trim()

    let parsed: any
    try {
      parsed = JSON.parse(clean)
    } catch (parseErr) {
      console.error(`[${provider.name}] ❌ JSON Parse Error. Raw content (first 200 chars):`, content.substring(0, 200))
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
    
    // 1. Fetch News (Menggunakan NewsAPI Key yang sudah Anda set di Vercel)
    const news = await fetchNews(market.question)
    const fullContext = baseContext + news

    // 2. Siapkan Provider (Hanya yang punya key)
    const activeProviders = LLM_PROVIDERS.filter(p => p.key && p.key.trim() !== '')
    
    if (activeProviders.length === 0) {
      console.error('[analyzeMarket] ❌ CRITICAL: No API keys configured!')
      return getDefaultSignal(market, yesPrice)
    }

    console.log(`[analyzeMarket] Active providers: ${activeProviders.map(p => p.name).join(', ')}`)

    // 3. Menjalankan 4 Analisis Paralel + 1 News Analysis (Total 5)
    // Kita rotasi provider untuk 4 LLM utama, dan tambahkan NewsAnalyst
    
    const getProvider = (index: number) => activeProviders[index % activeProviders.length]
    
    const results = await Promise.all([
      // 1. Market Analyst (LLM)
      callLLM(getProvider(0), PROMPTS.MARKET, fullContext),
      // 2. Risk Analyst (LLM)
      callLLM(getProvider(1), PROMPTS.RISK, fullContext),
      // 3. Sentiment Analyst (LLM)
      callLLM(getProvider(2), PROMPTS.SENTIMENT, fullContext),
      // 4. LLM Tambahan (agar ada 4 LLM yang berjalan)
      callLLM(getProvider(3), PROMPTS.MARKET, fullContext),
      // 5. NEWS ANALYST (Menggunakan NewsAPI + Prompt Khusus)
      // Kita pakai provider pertama yang ada untuk memproses konteks berita ini
      callLLM(getProvider(0), PROMPTS.NEWS_ANALYST, news || fullContext) 
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
// 8. BATCH ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeMarketsBatch(markets: PolymarketMarket[]): Promise<CombinedSignal[]> {
  const signals: CombinedSignal[] = []
  const CONCURRENCY = 3 
  let completed = 0

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(async (market) => {
      const signal = await analyzeMarket(market)
      completed++
      if (completed % 5 === 0) console.log(`Batch Progress: ${Math.round(completed / markets.length * 100)}%`)
      return signal
    }))

    signals.push(...batchResults)
    
    if (i + CONCURRENCY < markets.length) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence)
}
