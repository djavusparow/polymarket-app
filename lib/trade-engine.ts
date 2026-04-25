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

export function savePortfoli
