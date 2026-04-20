// ─── Polymarket Types ────────────────────────────────────────────────────────

export interface PolymarketToken {
  token_id: string
  outcome: string
  price?: number
  winner?: boolean
}

export interface PolymarketMarket {
  id: string
  condition_id: string
  question: string
  description?: string
  category?: string
  end_date_iso?: string
  active: boolean
  closed: boolean
  volume?: number
  volume24hr?: number // Sesuai dokumentasi Gamma API
  liquidity?: number
  best_bid?: number
  best_ask?: number
  last_trade_price?: number
  outcomes?: string[]
  outcomePrices?: string[]
  clobTokenIds?: string[]
  tokens?: PolymarketToken[] // Sesuai dokumentasi resmi (menggunakan tipe PolymarketToken)
  image?: string
  icon?: string
  minimum_tick_size?: number
  neg_risk?: boolean

  // Field tambahan yang disarankan sebelumnya
  market_slug?: string
  maker_base_fee?: number
  taker_base_fee?: number
  accepting_orders?: boolean
  archived?: boolean
  fpmm?: string
  game_start_time?: string
  rewards?: {
    max_spread: number
    min_size: number
    rates: any | null
  }

  // Field tambahan dari dokumentasi resmi terbaru
  question_id?: string
  accepting_order_timestamp?: string | null
  enable_order_book?: boolean
  is_50_50_outcome?: boolean
  minimum_order_size?: number
  neg_risk_market_id?: string
  neg_risk_request_id?: string
  notifications_enabled?: boolean
  seconds_delay?: number
  tags?: string[]
}

export interface MarketPrice {
  token_id: string
  price: number
  bid: number
  ask: number
}

// ─── AI Signal Types ─────────────────────────────────────────────────────────

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD'

export type AIModel = 'claude-sonnet' | 'ensemble'

export interface AIAnalysis {
  model: AIModel
  signal: SignalDirection
  confidence: number // 0-100
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
  confidence: number // ensemble confidence 0-100
  analyses: AIAnalysis[]
  yesPrice: number
  noPrice: number
  recommendedSide: 'YES' | 'NO'
  timestamp: number
  executed?: boolean
}

// ─── Trade Types ──────────────────────────────────────────────────────────────

export type TradeStatus = 
  | 'PENDING' 
  | 'OPEN' 
  | 'CLOSED' 
  | 'CANCELLED' 
  | 'STOP_LOSS' 
  | 'TAKE_PROFIT'
  | 'MATCHED'   // CLOB API status
  | 'MINED'     // CLOB API status
  | 'CONFIRMED' // CLOB API status
  | 'RETRYING'  // CLOB API status
  | 'FAILED'    // CLOB API status

export type TradeSide = 'YES' | 'NO'

export interface Trade {
  id: string
  market_id: string
  condition_id: string
  question: string
  side: TradeSide
  token_id: string
  size: number
  entry_price: number
  current_price?: number
  exit_price?: number
  stop_loss?: number
  take_profit?: number
  pnl?: number
  pnl_pct?: number
  status: TradeStatus  // Now accepts all CLOB statuses
  signal_confidence: number
  ai_rationale: string
  order_id?: string
  opened_at: number
  closed_at?: number
}

// ─── Settings Types ───────────────────────────────────────────────────────────

export interface TradingSettings {
  auto_trade_enabled: boolean
  min_confidence: number // 0-100, default 75
  min_trade_size: number // USDC
  max_trade_size: number // USDC
  default_stop_loss: number // percentage 0-100
  default_take_profit: number // percentage 0-100
  max_open_positions: number
  max_daily_trades: number
  max_daily_loss: number // USDC
  enabled_categories: string[]
}

export interface AccountCredentials {
  private_key: string  // Diperlukan untuk Wallet signer
  api_key: string
  api_secret: string
  api_passphrase: string
  funder_address: string
  /** 0 = EOA (MetaMask / hardware wallet), 1 = POLY_PROXY (email / Magic link) */
  signature_type: 0 | 1 | 2
}

// ─── Portfolio Types ──────────────────────────────────────────────────────────

export interface PortfolioStats {
  total_balance: number
  available_balance: number
  total_value: number // balance + open positions value
  total_pnl: number
  total_pnl_pct: number
  today_pnl: number
  today_trades: number
  win_rate: number
  open_positions: number
}
