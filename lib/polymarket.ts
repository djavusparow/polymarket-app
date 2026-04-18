import type { PolymarketMarket, MarketPrice } from './types'

const GAMMA_API  = 'https://gamma-api.polymarket.com'
const CLOB_API   = 'https://clob.polymarket.com'
const DATA_API   = 'https://data-api.polymarket.com'

// ─── Public Market Data (Gamma API — no auth) ─────────────────────────────────

export async function fetchActiveMarkets(limit = 50, offset = 0): Promise<PolymarketMarket[]> {
  try {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(limit),
      offset: String(offset),
    })
    const res = await fetch(`${GAMMA_API}/markets?${params}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`)
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.error('[polytrade] fetchActiveMarkets error:', e)
    return []
  }
}

export async function fetchTopVolumeMarkets(limit = 20): Promise<PolymarketMarket[]> {
  try {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(limit),
      order: 'volume24hr',
      ascending: 'false',
    })
    const res = await fetch(`${GAMMA_API}/markets?${params}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Gamma API ${res.status}`)
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.error('[polytrade] fetchTopVolumeMarkets error:', e)
    return []
  }
}

export async function fetchMarketByConditionId(conditionId: string): Promise<PolymarketMarket | null> {
  try {
    const res = await fetch(`${GAMMA_API}/markets/${conditionId}`, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ─── CLOB Real-Time Price Data (public, no auth) ──────────────────────────────

export async function fetchTokenPrice(tokenId: string): Promise<MarketPrice | null> {
  try {
    // Fetch best bid and best ask simultaneously
    const [bidRes, askRes] = await Promise.all([
      fetch(`${CLOB_API}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`),
      fetch(`${CLOB_API}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`),
    ])
    const bid = bidRes.ok ? await bidRes.json() : null
    const ask = askRes.ok ? await askRes.json() : null
    const bidPrice = parseFloat(bid?.price ?? '0')
    const askPrice = parseFloat(ask?.price ?? '0')
    const mid = bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : bidPrice || askPrice
    return { token_id: tokenId, price: mid, bid: bidPrice, ask: askPrice }
  } catch {
    return null
  }
}

// Batch fetch midpoint prices for multiple tokens (CLOB public endpoint)
export async function fetchMidpointPrices(tokenIds: string[]): Promise<Record<string, number>> {
  if (tokenIds.length === 0) return {}
  try {
    // POST /midpoints body: { token_ids: [...] }
    const res = await fetch(`${CLOB_API}/midpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_ids: tokenIds }),
    })
    if (!res.ok) return {}
    const data = await res.json()
    // Response: { "tokenId": "0.52", ... }
    const result: Record<string, number> = {}
    for (const [k, v] of Object.entries(data)) {
      result[k] = parseFloat(v as string) || 0
    }
    return result
  } catch {
    return {}
  }
}

export async function fetchLastTradePrices(tokenIds: string[]): Promise<Record<string, number>> {
  if (tokenIds.length === 0) return {}
  try {
    const res = await fetch(`${CLOB_API}/last-trade-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_ids: tokenIds }),
    })
    if (!res.ok) return {}
    const data: Array<{ token_id: string; price: string }> = await res.json()
    const result: Record<string, number> = {}
    for (const item of data) {
      result[item.token_id] = parseFloat(item.price) || 0
    }
    return result
  } catch {
    return {}
  }
}

export async function fetchMarketBookSummary(tokenId: string) {
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Fetch tick size for a token (needed for order construction)
export async function fetchTickSize(tokenId: string): Promise<string> {
  try {
    const res = await fetch(`${CLOB_API}/tick-size?token_id=${encodeURIComponent(tokenId)}`)
    if (!res.ok) return '0.01'
    const data = await res.json()
    return data?.minimum_tick_size ?? data?.tick_size ?? '0.01'
  } catch {
    return '0.01'
  }
}

// ─── Portfolio / Positions (Data API — public, by wallet address) ─────────────

export async function fetchUserPositions(walletAddress: string) {
  try {
    const res = await fetch(
      `${DATA_API}/v2/positions?user=${walletAddress}&sizeThreshold=.1`,
      { cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export async function fetchUserTrades(walletAddress: string, limit = 50) {
  try {
    const res = await fetch(
      `${DATA_API}/v2/activity?user=${walletAddress}&limit=${limit}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

// ─── Route Handler Wrappers ───────────────────────────────────────────────────

export async function serverFetchMarkets(limit = 50): Promise<PolymarketMarket[]> {
  return fetchActiveMarkets(limit)
}

export async function serverFetchTopMarkets(): Promise<PolymarketMarket[]> {
  return fetchTopVolumeMarkets(20)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getYesNoTokenIds(market: PolymarketMarket): { yes: string; no: string } | null {
  const tokens = market.clobTokenIds
  if (!tokens || tokens.length < 2) return null
  return { yes: tokens[0], no: tokens[1] }
}

/**
 * Correctly parse outcomePrices from Gamma API.
 * Gamma may return it as:
 *   - string[] e.g. ["0.52", "0.48"]
 *   - JSON-encoded array string e.g. '["0.52", "0.48"]'
 *   - plain number string e.g. "0.52"
 * Returns the YES (index 0) probability as a number 0-1.
 */
export function parseOutcomePrice(price: string | string[] | undefined): number {
  if (!price) return 0.5
  // Already an array — take first element
  if (Array.isArray(price)) {
    return parseFloat(price[0]) || 0.5
  }
  // JSON-encoded array string
  try {
    const parsed = JSON.parse(price)
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parseFloat(parsed[0]) || 0.5
    }
  } catch {
    // not JSON, fall through
  }
  // Plain number string
  const n = parseFloat(price)
  return isNaN(n) ? 0.5 : n
}

export function formatVolume(vol: number | undefined): string {
  if (!vol) return '$0'
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`
  return `$${vol.toFixed(0)}`
}
