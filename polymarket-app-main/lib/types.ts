export interface PolymarketToken {
  token_id: string
}

export interface PolymarketMarket {
  id: string
  question: string
  description?: string
  category?: string
  outcomePrices?: string[]
  clobTokenIds?: string[]
  tokens?: PolymarketToken[]
  image?: string
  volume24hr?: number
  volume?: number
  liquidity?: number
  best_bid?: number
  best_ask?: number
  end_date_iso?: string
  condition_id?: string
  neg_risk?: boolean
  minimum_tick_size?: string
}

export interface MarketPrice {
  token_id: string
  price: number
  bid: number
  ask: number
}

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD'

export interface AIAnalysis {
  model: string
  signal: SignalDirection
  confidence: number
  rationale: string
  targetPrice: number
  stopLoss: number
  takeProfit: number
  timestamp: number
}

export interface CombinedSignal {
  market_id: string
  question: string
  direction: SignalDirection
  confidence: number
  analyses: AIAnalysis[]
  yesPrice: number
  noPrice: number
  recommendedSide: 'YES' | 'NO'
  timestamp: Date.now()
}

export interface Trade {
  id: string
  market_id: string
  question: string
  side: 'YES' | 'NO'
  size: number
  price: number
  status: 'OPEN' | 'PENDING' | 'CLOSED'
  entry_price: number
  current_price?: number
  pnl?: number
  opened_at: number
  ai_confidence: number
}

export interface PortfolioStats {
  total_balance: number
  available_balance: number
  total_pnl: number
  win_rate: number
  open_positions: number
}

export interface TradingSettings {
  auto_trade_enabled: boolean
  min_confidence: number
  min_trade_size: number
  max_trade_size: number
  default_stop_loss: number
  default_take_profit: number
  max_open_positions: number
  max_daily_trades: number
}

export interface AccountCredentials {
  api_key: string
  api_secret: string
  api_passphrase: string
  funder_address: string
  private_key?: string
  signature_type: 0 | 1 | 2
}
