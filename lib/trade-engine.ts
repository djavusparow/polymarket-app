import type { Trade, CombinedSignal, TradingSettings, PortfolioStats, AccountCredentials } from './types'

const TRADES_KEY = 'polytrade_trades'
const SETTINGS_KEY = 'polytrade_settings'
const CREDENTIALS_KEY = 'polytrade_credentials'
const PORTFOLIO_KEY = 'polytrade_portfolio'

// ─── Default Settings ─────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: TradingSettings = {
  auto_trade_enabled: false,
  min_confidence: 75,
  min_trade_size: 10,
  max_trade_size: 100,
  default_stop_loss: 30,
  default_take_profit: 80,
  max_open_positions: 10,
  max_daily_trades: 20,
  max_daily_loss: 200,
  enabled_categories: [],
}

// ─── Trade Storage ────────────────────────────────────────────────────────────

export function getTrades(): Trade[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(TRADES_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function saveTrades(trades: Trade[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(TRADES_KEY, JSON.stringify(trades))
}

export function addTrade(trade: Trade): void {
  const trades = getTrades()
  trades.unshift(trade)
  saveTrades(trades)
}

export function updateTrade(id: string, updates: Partial<Trade>): void {
  const trades = getTrades()
  const idx = trades.findIndex(t => t.id === id)
  if (idx !== -1) {
    trades[idx] = { ...trades[idx], ...updates }
    saveTrades(trades)
  }
}

export function getOpenTrades(): Trade[] {
  return getTrades().filter(t => t.status === 'OPEN' || t.status === 'PENDING')
}

// ─── Settings Storage ─────────────────────────────────────────────────────────

export function getSettings(): TradingSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const stored = localStorage.getItem(SETTINGS_KEY)
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: TradingSettings): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

// ─── Credentials Storage ──────────────────────────────────────────────────────

export function getCredentials(): AccountCredentials | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = localStorage.getItem(CREDENTIALS_KEY)
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

export function saveCredentials(creds: AccountCredentials): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(creds))
}

export function clearCredentials(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(CREDENTIALS_KEY)
}

// ─── Portfolio Stats ──────────────────────────────────────────────────────────

export function getPortfolioStats(): PortfolioStats {
  if (typeof window === 'undefined') return defaultPortfolio()
  try {
    const stored = localStorage.getItem(PORTFOLIO_KEY)
    return stored ? JSON.parse(stored) : defaultPortfolio()
  } catch {
    return defaultPortfolio()
  }
}

export function savePortfolioStats(stats: PortfolioStats): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(stats))
}

function defaultPortfolio(): PortfolioStats {
  return {
    total_balance: 0,
    available_balance: 0,
    total_value: 0,
    total_pnl: 0,
    total_pnl_pct: 0,
    today_pnl: 0,
    today_trades: 0,
    win_rate: 0,
    open_positions: 0,
  }
}

// ─── Auto Trade Executor (via API Route) ─────────────────────────────────────

export async function executeAutoTrade(signal: CombinedSignal, settings: TradingSettings): Promise<{
  success: boolean
  trade?: Trade
  error?: string
}> {
  if (!settings.auto_trade_enabled) return { success: false, error: 'Auto trading disabled' }
  if (signal.confidence < settings.min_confidence) {
    return { success: false, error: `Confidence ${signal.confidence}% below minimum ${settings.min_confidence}%` }
  }

  const openTrades = getOpenTrades()
  if (openTrades.length >= settings.max_open_positions) {
    return { success: false, error: 'Maximum open positions reached' }
  }

  // Check daily trade limit
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayTrades = getTrades().filter(t => t.opened_at >= todayStart)
  if (todayTrades.length >= settings.max_daily_trades) {
    return { success: false, error: 'Daily trade limit reached' }
  }

  // Calculate trade size (position sizing based on confidence)
  const confidenceMultiplier = Math.min(signal.confidence / 100, 1)
  const tradeSize = Math.round(
    settings.min_trade_size + (settings.max_trade_size - settings.min_trade_size) * confidenceMultiplier
  )

  const price = signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice

  // Pass stored credentials to server so it can sign the CLOB request
  const storedCreds = getCredentials()
  const clobCreds = storedCreds?.api_key
    ? {
        apiKey:        storedCreds.api_key,
        apiSecret:     storedCreds.api_secret,
        apiPassphrase: storedCreds.api_passphrase,
        funderAddress: storedCreds.funder_address,
        signatureType: storedCreds.signature_type ?? 1,
      }
    : undefined

  // Call server-side API route to place the actual order
  try {
    const res = await fetch('/api/trade/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market_id: signal.market_id,
        question: signal.question,
        side: signal.recommendedSide,
        size: tradeSize,
        price,
        signal_confidence: signal.confidence,
        ai_rationale: signal.analyses.map(a => a.rationale).join(' | '),
        stop_loss_pct: settings.default_stop_loss,
        take_profit_pct: settings.default_take_profit,
        credentials: clobCreds,  // bridge: Settings UI → server CLOB signing
      }),
    })

    const result = await res.json()
    if (!res.ok || result.error) {
      return { success: false, error: result.error ?? 'Trade execution failed' }
    }

    const trade: Trade = {
      id: result.trade_id ?? crypto.randomUUID(),
      market_id: signal.market_id,
      condition_id: result.condition_id ?? '',
      question: signal.question,
      side: signal.recommendedSide,
      token_id: result.token_id ?? '',
      size: tradeSize,
      entry_price: price,
      current_price: price,
      stop_loss: price * (1 - settings.default_stop_loss / 100),
      take_profit: Math.min(price * (1 + settings.default_take_profit / 100), 0.99),
      status: 'OPEN',
      signal_confidence: signal.confidence,
      ai_rationale: signal.analyses.map(a => `[${a.model}] ${a.rationale}`).join('\n'),
      order_id: result.order_id,
      opened_at: Date.now(),
    }

    addTrade(trade)
    return { success: true, trade }
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'Network error'
    return { success: false, error: errorMessage }
  }
}

// ─── P&L Calculation ──────────────────────────────────────────────────────────

export function calculateTradePnL(trade: Trade): { pnl: number; pnl_pct: number } {
  const price = trade.current_price ?? trade.entry_price
  const pnl = (price - trade.entry_price) * trade.size
  const pnl_pct = trade.entry_price > 0 ? ((price - trade.entry_price) / trade.entry_price) * 100 : 0
  return { pnl, pnl_pct }
}

export function calculatePortfolioStats(): PortfolioStats {
  const trades = getTrades()
  const openTrades = trades.filter(t => t.status === 'OPEN')
  const closedTrades = trades.filter(t => ['CLOSED', 'STOP_LOSS', 'TAKE_PROFIT'].includes(t.status))

  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayPnl = closedTrades
    .filter(t => (t.closed_at ?? 0) >= todayStart)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0)

  const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0).length
  const winRate = closedTrades.length > 0 ? (winners / closedTrades.length) * 100 : 0

  const todayTrades = trades.filter(t => t.opened_at >= todayStart).length

  return {
    total_balance: 0, // Fetched from real API
    available_balance: 0,
    total_value: 0,
    total_pnl: totalPnl,
    total_pnl_pct: 0,
    today_pnl: todayPnl,
    today_trades: todayTrades,
    win_rate: winRate,
    open_positions: openTrades.length,
  }
}
