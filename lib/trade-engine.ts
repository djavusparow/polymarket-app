// lib/trade-engine.ts

import type {
  Trade,
  CombinedSignal,
  TradingSettings,
  PortfolioStats,
  AccountCredentials,
  SignalDirection
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

  // Hitung P&L dari trade yang sudah ditutup (Closed)
  const totalPnl = closedTrades.reduce((sum, t) => {
    const exitPrice = t.exit_price ?? t.entry_price
    const shares = t.size / t.entry_price
    return sum + (exitPrice - t.entry_price) * shares
  }, 0)

  // P&L Hari Ini
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayPnl = closedTrades
    .filter((t) => (t.closed_at ?? 0) >= todayStart)
    .reduce((sum, t) => {
      const exitPrice = t.exit_price ?? t.entry_price
      const shares = t.size / t.entry_price
      return sum + (exitPrice - t.entry_price) * shares
    }, 0)

  // Win Rate
  const winners = closedTrades.filter((t) => {
    const exitPrice = t.exit_price ?? t.entry_price
    const shares = t.size / t.entry_price
    return (exitPrice - t.entry_price) * shares > 0
  }).length

  const winRate = closedTrades.length > 0 ? (winners / closedTrades.length) * 100 : 0

  // Hari Ini (Trades yang dibuka hari ini)
  const todayTrades = trades.filter((t) => t.opened_at >= todayStart).length

  return {
    total_balance: 0,
    available_balance: 0,
    total_value: 0,
    total_pnl: totalPnl,
    total_pnl_pct: totalPnl > 0 ? (totalPnl / (trades.reduce((sum, t) => sum + t.size, 0) || 1)) * 100 : 0,
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
    return { valid: false, error: '
