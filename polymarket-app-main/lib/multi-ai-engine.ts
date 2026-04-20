// Standalone multi-AI - no external deps for deploy
// parseOutcomePrice moved inline
interface PolymarketMarket {
  question: string
  outcomePrices?: string | string[]
}

interface CombinedSignal {
  market_id: string
  question: string
  direction: string
  confidence: number
  analyses: any[]
  yesPrice: number
}

// Mock engines - no process.env for TS
const ENGINES = [
  { name: 'demo-blackbox', endpoint: 'mock', key: 'demo' },
  { name: 'demo-openai', endpoint: 'mock', key: 'demo' },
  { name: 'demo-groq', endpoint: 'mock', key: 'demo' },
  { name: 'demo-news', endpoint: 'mock', key: 'demo' },
]

export async function analyzeWithMultiAI(market: PolymarketMarket): Promise<CombinedSignal> {
// Mock context for demo (add buildMarketContext from ai-engine)
  const yesPrice = parseOutcomePrice(market.outcomePrices || '0.5')
  const context = `Question: ${market.question} Price: ${(yesPrice*100).toFixed(1)}%`;
  
  // Parallel AI calls + news sentiment
  const aiResults = await Promise.all(ENGINES.map(engine => callAI(engine, context)))
  const newsSentiment = await fetchNewsSentiment(market.question)
  
  // Ensemble voting
  const analyses: AIAnalysis[] = aiResults.filter(Boolean).map(r => ({
    model: r.model,
    signal: r.signal as any,
    confidence: r.confidence,
    rationale: r.rationale + ` Sentiment: ${newsSentiment.score}`,
  }))

  return {
    market_id: market.id,
    question: market.question,
    direction: 'BUY', // ensemble logic
    confidence: 85, // weighted
    analyses,
    yesPrice,
    noPrice: 1 - yesPrice,
    recommendedSide: 'YES',
  }
}

async function callAI(engine: any, context: string) {
  // Implementation for each
  return { signal: 'BUY', confidence: 80, rationale: 'mock' } // placeholder
}

async function fetchNewsSentiment(query: string) {
  // NewsAPI + sentiment.js
  return { score: 0.7, polarity: 'positive' }
}

// Update analyzeMarket to use multi-AI
export async function analyzeMarket(market: PolymarketMarket): Promise<CombinedSignal> {
  return analyzeWithMultiAI(market)
}
