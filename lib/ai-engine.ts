import type {
  PolymarketMarket,
  AIAnalysis,
  CombinedSignal,
  AIModel,
  SignalDirection,
} from './types';
import { parseOutcomePrice } from './polymarket';

// ────────────────────────────────────────────────────────────────────────
// 1. ENVIRONMENT VARIABLES
// ────────────────────────────────────────────────────────────────────────
const NEWS_API_KEY = process.env.NEWSAPI_KEY || '';
const BLACKBOX_API_KEY = process.env.BLACKBOX_API_KEY || '';
// Optional – Blackbox *customerId* (perlu untuk beberapa akun)
const BLACKBOX_CUSTOMER_ID = process.env.BLACKBOX_CUSTOMER_ID || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// ────────────────────────────────────────────────────────────────────────
// 2. PROVIDERS CONFIGURATION
// ────────────────────────────────────────────────────────────────────────
const LLM_PROVIDERS = [
  {
    name: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: DEEPSEEK_API_KEY,
  },
  {
    name: 'blackbox',
    endpoint: 'https://llm.blackbox.ai/chat/completions',
    model: 'claude-3.5-sonnet',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: BLACKBOX_API_KEY,
  },
  {
    name: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: OPENAI_API_KEY,
  },
  {
    name: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key: GROQ_API_KEY,
  },
] as const;

// ────────────────────────────────────────────────────────────────────────
// 3. PROMPTS (termasuk analisis berita)
// ────────────────────────────────────────────────────────────────────────
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
Your role is to evaluate market risks and provide risk‑adjusted trading signals.
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

  // Prompt khusus untuk menilai dampak berita (NewsAPI)
  NEWS_ANALYST: `You are a news analyst for prediction markets.
Your role is to evaluate recent headlines and decide how they affect the market outcome.
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

// ────────────────────────────────────────────────────────────────────────
// 4. NEWS FETCHING (NewsAPI)
// ────────────────────────────────────────────────────────────────────────
async function fetchNews(query: string): Promise<string> {
  if (!NEWS_API_KEY) return '';
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(
        query
      )}&sortBy=publishedAt&language=en&pageSize=5&apiKey=${NEWS_API_KEY}`,
      { signal: ctrl.signal }
    );
    clearTimeout(timeoutId);
    if (!res.ok) return '';
    const data = await res.json();
    if (!data.articles?.length) return '';
    const lines = data.articles
      .slice(0, 3)
      .map((a: any) => `- ${a.title} (Source: ${a.source?.name || 'unknown'})`);
    return `\n\nLATEST NEWS:\n${lines.join('\n')}`;
  } catch (e) {
    console.warn('[NewsAPI] fetch error:', e);
    return '';
  }
}

// ────────────────────────────────────────────────────────────────────────
// 5. CALL LLM – penanganan DeepSeek + Blackbox, parsing toleran
// ────────────────────────────────────────────────────────────────────────
async function callLLM(
  provider: typeof LLM_PROVIDERS[number],
  prompt: string,
  context: string
): Promise<AIAnalysis | null> {
  if (!provider.key || provider.key.trim() === '') return null;

  console.log(`[callLLM] ${provider.name} → ${provider.model}`);

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 45_000); // 45 s timeout

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [provider.keyHeader]: `${provider.keyPrefix}${provider.key}`,
    };

    // ---- Blackbox: tambahkan customerId bila tersedia ----
    if (provider.name === 'blackbox' && BLACKBOX_CUSTOMER_ID) {
      headers['customerId'] = BLACKBOX_CUSTOMER_ID;
    }

    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: context },
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
      signal: ctrl.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const txt = await res.text();
      console.error(`[${provider.name}] ❌ HTTP ${res.status}: ${txt.slice(0, 120)}...`);
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? '';

    // ---------- EXTRACT JSON (toleran) ----------
    let jsonStr = raw.trim();

    // 1️⃣ Cari blok ```json ... ```
    const fencedJson = jsonStr.match(/```json\s*([\s\S]*?)\s*```/);
    if (fencedJson) jsonStr = fencedJson[1];
    else {
      // 2️⃣ Cari blok ``` ... ```
      const fenced = jsonStr.match(/```([\s\S]*?)```/);
      if (fenced) jsonStr = fenced[1];
      else {
        // 3️⃣ Cari objek JSON pertama { … } terakhir }
        const first = jsonStr.indexOf('{');
        const last = jsonStr.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
          jsonStr = jsonStr.substring(first, last + 1);
        }
      }
    }

    // 4️⃣ Hapus karakter yang tak diperlukan (newline, carriage‑return)
    jsonStr = jsonStr.replace(/\r?\n/g, '').trim();

    // 5️⃣ Jika masih tidak berakhir dengan '}' – potong sampai brace terakhir
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace !== -1 && lastBrace < jsonStr.length - 1) {
      jsonStr = jsonStr.substring(0, lastBrace + 1);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error(
        `[${provider.name}] ❌ JSON Parse Error. Raw content (first 200 chars):`,
        raw.substring(0, 200)
      );
      // ---- Fallback ringan: ekstrak field secara regex ----
      const fallback = (key: string) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"?([^",}\\n]+)"?`, 'i'));
        return m ? m[1].trim() : undefined;
      };
      const signal = fallback('signal') as SignalDirection | undefined;
      const confidence = Number(fallback('confidence'));
      if (!signal || isNaN(confidence)) return null;
      parsed = {
        signal,
        confidence,
        rationale: fallback('rationale') || '',
        true_probability_yes: Number(fallback('true_probability_yes')) || 0.5,
        edge: Number(fallback('edge')) || 0,
        target_price: Number(fallback('target_price')) || 0.5,
        stop_loss_pct: Number(fallback('stop_loss_pct')) || 20,
        take_profit_pct: Number(fallback('take_profit_pct')) || 50,
      };
    }

    // --------‑ Validasi wajib ---------
    if (!parsed.signal || !['BUY', 'SELL', 'HOLD'].includes(parsed.signal))
      return null;
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100)
      return null;

    console.log(`[${provider.name}] ✅ Success! Confidence: ${parsed.confidence}`);

    return {
      model: provider.name as AIModel,
      signal: parsed.signal as SignalDirection,
      confidence: parsed.confidence,
      rationale: String(parsed.rationale || ''),
      targetPrice: Number(parsed.target_price) || 0.5,
      stopLoss: Number(parsed.stop_loss_pct) || 20,
      takeProfit: Number(parsed.take_profit_pct) || 50,
      timestamp: Date.now(),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[${provider.name}] ❌ Error:`, err);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 6. ENSEMBLE LOGIC
// ────────────────────────────────────────────────────────────────────────
function ensemble(
  analyses: AIAnalysis[]
): { direction: SignalDirection; confidence: number; recommendedSide: 'YES' | 'NO' } {
  const valid = analyses.filter((a) => a.confidence > 0);
  if (!valid.length) return { direction: 'HOLD', confidence: 0, recommendedSide: 'YES' };

  const buyScore = valid.filter((a) => a.signal === 'BUY').reduce((s, a) => s + a.confidence, 0);
  const sellScore = valid.filter((a) => a.signal === 'SELL').reduce((s, a) => s + a.confidence, 0);
  const totalScore = buyScore + sellScore;
  const avgConf = valid.reduce((s, a) => s + a.confidence, 0) / valid.length;

  if (totalScore === 0) {
    return { direction: 'HOLD', confidence: Math.round(avgConf * 0.5), recommendedSide: 'YES' };
  }

  if (buyScore > sellScore && buyScore / totalScore > 0.4) {
    return { direction: 'BUY', confidence: Math.round((buyScore / totalScore) * avgConf), recommendedSide: 'YES' };
  }
  if (sellScore > buyScore && sellScore / totalScore > 0.4) {
    return { direction: 'SELL', confidence: Math.round((sellScore / totalScore) * avgConf), recommendedSide: 'NO' };
  }
  return { direction: 'HOLD', confidence: Math.round(avgConf * 0.5), recommendedSide: 'YES' };
}

// ────────────────────────────────────────────────────────────────────────
// 7. MAIN ANALYSIS FUNCTION
// ────────────────────────────────────────────────────────────────────────
export async function analyzeMarket(market: PolymarketMarket): Promise<CombinedSignal> {
  const start = Date.now();
  console.log(`[analyzeMarket] Starting for: ${market.id}`);

  try {
    const yesPrice = parseOutcomePrice(market.outcomePrices);
    const baseContext = buildMarketContext(market);

    // ---- News ----
    const news = await fetchNews(market.question);
    const fullContext = baseContext + news; // news already appended as string

    // ---- Provider list (filter yang punya key) ----
    const activeProviders = LLM_PROVIDERS.filter((p) => p.key && p.key.trim() !== '');
    if (!activeProviders.length) {
      console.error('[analyzeMarket] ❌ No API keys configured!');
      return getDefaultSignal(market, yesPrice);
    }

    console.log(`[analyzeMarket] Active providers: ${activeProviders.map((p) => p.name).join(', ')}`);

    // ---- Rotasi provider (memastikan maksimal 4 LLM) ----
    const getProvider = (i: number) => activeProviders[i % activeProviders.length];

    const results = await Promise.all([
      // 1️⃣ Market analyst
      callLLM(getProvider(0), PROMPTS.MARKET, fullContext),
      // 2️⃣ Risk analyst
      callLLM(getProvider(1), PROMPTS.RISK, fullContext),
      // 3️⃣ Sentiment analyst
      callLLM(getProvider(2), PROMPTS.SENTIMENT, fullContext),
      // 4️⃣ LLM ke‑4 (menggunakan kembali prompt market, sehingga selalu ada 4 panggilan LLM)
      callLLM(getProvider(3), PROMPTS.MARKET, fullContext),
      // 5️⃣ News analyst (pakai provider pertama; news sudah di‑string‑kan)
      callLLM(getProvider(0), PROMPTS.NEWS_ANALYST, news || fullContext),
    ]);

    const analyses = results.filter(Boolean) as AIAnalysis[];
    console.log(
      `[analyzeMarket] Completed in ${Date.now() - start}ms. Success: ${analyses.length}/${results.length}`
    );

    const ensembleResult = ensemble(analyses);

    return {
      market_id: market.id,
      question: market.question,
      direction: ensembleResult.direction,
      confidence: ensembleResult.confidence,
      analyses,
      yesPrice,
      noPrice: 1 - yesPrice,
      recommendedSide: ensembleResult.recommendedSide,
      timestamp: Date.now(),
    };
  } catch (e) {
    console.error('[analyzeMarket] ERROR:', e);
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helper: build market context string
// ────────────────────────────────────────────────────────────────────────
function buildMarketContext(market: PolymarketMarket): string {
  const yesPrice = parseOutcomePrice(market.outcomePrices);
  const volume = (market.volume24hr || 0).toLocaleString();
  return `MARKET: ${market.question}
CATEGORY: ${market.category || 'General'}
YES: ${(yesPrice * 100).toFixed(1)}% | NO: ${(100 - yesPrice * 100).toFixed(1)}%
VOL 24H: $${volume}
END: ${market.end_date_iso ? new Date(market.end_date_iso).toLocaleDateString() : 'TBD'}

Analyze and return JSON signal.`;
}

// ────────────────────────────────────────────────────────────────────────
// Helper: default signal bila semua gagal
// ────────────────────────────────────────────────────────────────────────
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
    timestamp: Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// 8. BATCH ANALYSIS (opsional)
// ────────────────────────────────────────────────────────────────────────
export async function analyzeMarketsBatch(markets: PolymarketMarket[]): Promise<CombinedSignal[]> {
  const signals: CombinedSignal[] = [];
  const CONCURRENCY = 3;
  let completed = 0;

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (m) => {
        const sig = await analyzeMarket(m);
        completed++;
        if (completed % 5 === 0) console.log(`Batch progress: ${Math.round((completed / markets.length) * 100)}%`);
        return sig;
      })
    );
    signals.push(...batchResults);
    if (i + CONCURRENCY < markets.length) await new Promise((r) => setTimeout(r, 1_000));
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}
