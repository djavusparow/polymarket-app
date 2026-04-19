import type {
  Trade,
  CombinedSignal,
  TradingSettings,
  PortfolioStats,
  AccountCredentials,
} from './types'

const TRADES_KEY = 'polytrade_trades'
const SETTINGS_KEY = 'polytrade_settings'
const CREDENTIALS_KEY = 'polytrade_credentials'
const PORTFOLIO_KEY = 'polytrade_portfolio'

// ─── Default Settings ───────────────────────────────────────────────────────

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

// ─── Trade Storage ────────────────────────────────────────────────────────

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
  const idx = trades.findIndex((t) => t.id === id)
  if (idx !== -1) {
    trades[idx] = { ...trades[idx], ...updates }
    saveTrades(trades)
  }
}

export function getOpenTrades(): Trade[] {
  return getTrades().filter((t) => t.status === 'OPEN' || t.status === 'PENDING')
}

// ─── Settings Storage ─────────────────────────────────────────────────────

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

// ─── Credentials Storage ───────────────────────────────────────────────────

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

// ─── Portfolio Stats Storage ───────────────────────────────────────────────

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

// ─── Fixed P&L Calculation for Prediction Markets ───────────────────────

export function calculateTradePnL(trade: Trade): {
  pnl: number
  pnl_pct: number
} {
  const currentPrice = trade.current_price ?? trade.entry_price
  const shares = trade.size / trade.entry_price
  const pnl = (currentPrice - trade.entry_price) * shares
  const pnl_pct = ((currentPrice - trade.entry_price) / trade.entry_price) * 100
  return { pnl, pnl_pct }
}

// ─── Portfolio Stats Calculation ───────────────────────────────────────────

export function calculatePortfolioStats(): PortfolioStats {
  const trades = getTrades()
  const openTrades = trades.filter((t) => t.status === 'OPEN')
  const closedTrades = trades.filter((t) =>
    ['CLOSED', 'STOP_LOSS', 'TAKE_PROFIT'].includes(t.status)
  )

  const totalPnl = closedTrades.reduce((sum, t) => {
    const exitPrice = t.exit_price ?? t.entry_price
    const shares = t.size / t.entry_price
    return sum + (exitPrice - t.entry_price) * shares
  }, 0)

  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayPnl = closedTrades
    .filter((t) => (t.closed_at ?? 0) >= todayStart)
    .reduce((sum, t) => {
      const exitPrice = t.exit_price ?? t.entry_price
      const shares = t.size / t.entry_price
      return sum + (exitPrice - t.entry_price) * shares
    }, 0)

  const winners = closedTrades.filter((t) => {
    const exitPrice = t.exit_price ?? t.entry_price
    const shares = t.size / t.entry_price
    return (exitPrice - t.entry_price) * shares > 0
  }).length

  const winRate = closedTrades.length > 0 ? (winners / closedTrades.length) * 100 : 0

  const todayTrades = trades.filter((t) => t.opened_at >= todayStart).length

  return {
    total_balance: 0,
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

// ─── Credential Validation ─────────────────────────────────────────────────

function validateCredentials(
  creds: AccountCredentials
): { valid: boolean; error?: string } {
  if (!creds) return { valid: false, error: 'Credentials required' }

  if (!creds.api_key?.trim()) {
    return { valid: false, error: 'API key required' }
  }
  if (!creds.api_secret?.trim()) {
    return { valid: false, error: 'API secret required' }
  }
  if (!creds.api_passphrase?.trim()) {
    return { valid: false, error: 'API passphrase required' }
  }
  if (!creds.funder_address?.trim()) {
    return { valid: false, error: 'Funder address required' }
  }
  if (!creds.funder_address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return { valid: false, error: 'Invalid funder address format' }
  }

  const sig = creds.signature_type ?? 0
  if (![0, 1, 2].includes(sig)) {
    return {
      valid: false,
      error: 'Signature type must be 0 (EOA), 1 or 2',
    }
  }

  return { valid: true }
}

// ─── Auto Trade Executor ─────────────────────────────────────────────────────

export async function executeAutoTrade(
  signal: CombinedSignal,
  settings: TradingSettings,
  retryCount = 0
): Promise<{ success: boolean; trade?: Trade; error?: string }> {
  if (!settings.auto_trade_enabled) {
    return { success: false, error: 'Auto trading disabled' }
  }
  if (signal.confidence < settings.min_confidence) {
    return {
      success: false,
      error: `Confidence ${signal.confidence}% below minimum ${settings.min_confidence}%`,
    }
  }

  const openTrades = getOpenTrades()
  if (openTrades.length >= settings.max_open_positions) {
    return { success: false, error: 'Maximum open positions reached' }
  }

  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayTrades = getTrades().filter((t) => t.opened_at >= todayStart)
  if (todayTrades.length >= settings.max_daily_trades) {
    return { success: false, error: 'Daily trade limit reached' }
  }

  const confidenceMultiplier = Math.min(signal.confidence / 100, 1)
  const tradeSize = Math.round(
    settings.min_trade_size +
      (settings.max_trade_size - settings.min_trade_size) * confidenceMultiplier
  )

  const price =
    signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice

  const storedCreds = getCredentials()
  if (!storedCreds) {
    return { success: false, error: 'API credentials not configured' }
  }

  const credCheck = validateCredentials(storedCreds)
  if (!credCheck.valid) {
    return { success: false, error: credCheck.error }
  }

  // ─── Gunakan signature type yang tepat berdasarkan wallet type ─────────────
  const clobCreds = {
    apiKey: storedCreds.api_key,
    apiSecret: storedCreds.api_secret,
    apiPassphrase: storedCreds.api_passphrase,
    funderAddress: storedCreds.funder_address,
    signatureType: storedCreds.signature_type ?? 0, // Default ke EOA
  }

  const stopLossPct = settings.default_stop_loss / 100
  const takeProfitPct = settings.default_take_profit / 100

  const stopLossPrice =
    signal.recommendedSide === 'YES'
      ? Math.max(0.01, price - price * stopLossPct)
      : Math.min(0.99, price + price * stopLossPct)

  const takeProfitPrice =
    signal.recommendedSide === 'YES'
      ? Math.min(0.99, price + price * takeProfitPct)
      : Math.max(0.01, price - price * takeProfitPct)

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
        ai_rationale: signal.analyses.map((a) => a.rationale).join(' | '),
        stop_loss_pct: settings.default_stop_loss,
        take_profit_pct: settings.default_take_profit,
        stop_loss_price: stopLossPrice,
        take_profit_price: takeProfitPrice,
        credentials: clobCreds,
      }),
    })

    const result = await res.json()

    if (!res.ok || result.error) {
      return {
        success: false,
        error: result.error ?? 'Trade execution failed',
      }
    }

    const expectedTokenId =
      signal.recommendedSide === 'YES'
        ? result.token_ids?.[0] ?? ''
        : result.token_ids?.[1] ?? ''

    if (!expectedTokenId) {
      return {
        success: false,
        error: 'Could not determine correct token ID for the chosen side',
      }
    }

    const trade: Trade = {
      id: result.trade_id ?? crypto.randomUUID(),
      market_id: signal.market_id,
      condition_id: result.condition_id ?? '',
      question: signal.question,
      side: signal.recommendedSide,
      token_id: expectedTokenId,
      size: tradeSize,
      entry_price: price,
      current_price: price,
      stop_loss: stopLossPrice,
      take_profit: takeProfitPrice,
      status: 'OPEN',
      signal_confidence: signal.confidence,
      ai_rationale: signal.analyses
        .map((a) => `[${a.model}] ${a.rationale}`)
        .join('\n'),
      order_id: result.order_id,
      opened_at: Date.now(),
    }

    addTrade(trade)
    return { success: true, trade }
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'Network error'

    if (retryCount < 1 && errorMessage.toLowerCase().includes('network')) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return executeAutoTrade(signal, settings, retryCount + 1)
    }

    return { success: false, error: errorMessage }
  }
}

// ─── Helper: Update Trade P&L When Price Changes ───────────────────────────

export function updateTradeWithPrice(
  tradeId: string,
  newPrice: number
): void {
  const trades = getTrades()
  const idx = trades.findIndex((t) => t.id === tradeId)
  if (idx === -1) return

  const trade = trades[idx]
  
  // Fix: Handle potentially undefined stop_loss/take_profit using fallback values
  const stopLoss = trade.stop_loss ?? (trade.side === 'YES' ? 0 : 1)
  const takeProfit = trade.take_profit ?? (trade.side === 'YES' ? 1 : 0)

  const shares = trade.size / trade.entry_price
  const pnl = (newPrice - trade.entry_price) * shares
  const pnl_pct = ((newPrice - trade.entry_price) / trade.entry_price) * 100

  const newStatus = (() => {
    // Use the fallback values for comparison
    if (
      (trade.side === 'YES' && newPrice <= stopLoss) ||
      (trade.side === 'NO' && newPrice >= stopLoss)
    ) {
      return 'STOP_LOSS'
    }
    if (
      (trade.side === 'YES' && newPrice >= takeProfit) ||
      (trade.side === 'NO' && newPrice <= takeProfit)
    ) {
      return 'TAKE_PROFIT'
    }
    return trade.status
  })()

  // Apply updates: if status changes to STOP_LOSS or TAKE_PROFIT, record exit details
  if (newStatus !== trade.status && ['STOP_LOSS', 'TAKE_PROFIT'].includes(newStatus)) {
    trades[idx] = {
      ...trade,
      current_price: newPrice,
      exit_price: newPrice,
      closed_at: Date.now(),
      pnl,
      pnl_pct,
      status: newStatus,
    }
  } else {
    trades[idx] = {
      ...trade,
      current_price: newPrice,
      pnl,
      pnl_pct,
      status: newStatus,
    }
  }

  saveTrades(trades)
}
