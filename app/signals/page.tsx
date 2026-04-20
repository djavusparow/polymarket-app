'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { BrainCircuit, TrendingUp, TrendingDown, Activity, Filter, Loader2, RefreshCw, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { getSettings, calculatePortfolioStats, addTrade, getCredentials } from '@/lib/trade-engine'
import type { CombinedSignal, PolymarketMarket, TradingSettings } from '@/lib/types'

type FilterType = 'all' | 'high' | 'buy' | 'sell'

// Type definition for API response
interface AnalyzeResponse {
  signal?: CombinedSignal
  error?: string
}

export default function SignalsPage() {
  const [markets, setMarkets] = useState<PolymarketMarket[]>([])
  const [signals, setSignals] = useState<CombinedSignal[]>([])
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [filter, setFilter] = useState<FilterType>('all')
  const [selected, setSelected] = useState<CombinedSignal | null>(null)
  const [executingId, setExecutingId] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  
  // Track individual market analysis status
  const [analyzingMarkets, setAnalyzingMarkets] = useState<Set<string>>(new Set())

  const settings = getSettings()
  const portfolio = calculatePortfolioStats()

  // Rate limiting delay: 500ms for better performance while respecting API limits
  const RATE_LIMIT_DELAY = 500

  // Signature type validation helper
  const validateSignatureType = (type: number): boolean => {
    return [0, 1, 2].includes(type) // EOA, POLY_PROXY, GNOSIS_SAFE
  }

  // Analyze with Retry (Handles 425 Engine Restart)
  const analyzeWithRetry = useCallback(async (market: PolymarketMarket): Promise<AnalyzeResponse | null> => {
    const MAX_RETRIES = 10
    let delay = 1000
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ market }),
        })
        
        if (response.status === 425) {
          console.log(`Engine restarting, retrying in ${delay/1000}s... (Attempt ${attempt + 1})`)
          await new Promise(r => setTimeout(r, delay))
          delay = Math.min(delay * 2, 30000) // Exponential backoff up to 30s
          continue
        }
        
        if (!response.ok) {
          console.warn(`API Error: ${response.status}`)
          return null
        }
        
        return await response.json()
      } catch (error) {
        console.warn(`Network error during analysis:`, error)
        // Wait before retrying on network error
        await new Promise(r => setTimeout(r, delay))
      }
    }
    
    console.error('Engine restart exceeded maximum retry attempts')
    return null
  }, [])

  const fetchAndScan = useCallback(async () => {
    setScanning(true)
    setProgress(0)
    setSignals([])
    setAnalyzingMarkets(new Set())
    setLastError(null)

    try {
      const res = await fetch('/api/markets?type=top&limit=15')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      
      const { markets: mData } = await res.json()
      const validMarkets = mData ?? []
      setMarkets(validMarkets)

      // Analyze each market with better error handling and rate limiting
      for (let i = 0; i < validMarkets.length; i++) {
        const market = validMarkets[i]
        setProgress(Math.round(((i + 1) / validMarkets.length) * 100))
        setAnalyzingMarkets(prev => new Set([...prev, market.id]))

        const result = await analyzeWithRetry(market)
        
        if (result?.signal) {
          setSignals(prev => [...prev, result.signal!].sort((a, b) => b.confidence - a.confidence))
        }

        // Remove from analyzing set
        setAnalyzingMarkets(prev => {
          const next = new Set(prev)
          next.delete(market.id)
          return next
        })

        // Rate limiting delay
        await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY))
      }
      
      // Reset retry count on success
      setRetryCount(0)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      setLastError(errorMsg)
      console.error('Failed to fetch markets:', errorMsg)
    } finally {
      setScanning(false)
    }
  }, [analyzeWithRetry, RATE_LIMIT_DELAY])

  // Exponential backoff retry logic for UI
  const handleRetry = useCallback(() => {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000)
    console.log(`Retrying in ${delay}ms... (Attempt ${retryCount + 1})`)
    setTimeout(() => {
      setRetryCount(prev => prev + 1)
      fetchAndScan()
    }, delay)
  }, [retryCount, fetchAndScan])

  // Initial fetch and cleanup on unmount
  useEffect(() => {
    fetchAndScan()

    return () => {
      // Cleanup to prevent memory leaks
      setAnalyzingMarkets(new Set())
      setSignals([])
    }
  }, [fetchAndScan])

  const executeSignal = async (signal: CombinedSignal) => {
    const storedCreds = getCredentials()
    
    // Null safety: Validate complete credentials before execution
    if (!storedCreds?.api_key || !storedCreds?.api_secret || !storedCreds?.funder_address) {
      alert('Please configure complete API credentials in Settings first')
      return
    }

    // Validate signature type
    if (!validateSignatureType(storedCreds.signature_type ?? 1)) {
       alert('Invalid signature type configured. Please check Settings.')
       return
    }

    setExecutingId(signal.market_id)
    const clobCreds = {
      apiKey:        storedCreds.api_key,
      apiSecret:     storedCreds.api_secret,
      apiPassphrase: storedCreds.api_passphrase,
      funderAddress: storedCreds.funder_address,
      signatureType: storedCreds.signature_type ?? 1,
    }

    try {
      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market_id: signal.market_id,
          question: signal.question,
          side: signal.recommendedSide,
          size: settings.min_trade_size,
          price: signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice,
          signal_confidence: signal.confidence,
          ai_rationale: signal.analyses.map(a => a.rationale).join(' | '),
          stop_loss_pct: settings.default_stop_loss,
          take_profit_pct: settings.default_take_profit,
          credentials: clobCreds,
        }),
      })
      const result = await res.json()
      if (result.success) {
        // Store trade locally
        addTrade({
          id: result.trade_id,
          market_id: signal.market_id,
          condition_id: result.condition_id ?? '',
          question: signal.question,
          side: signal.recommendedSide,
          token_id: result.token_id ?? '',
          size: settings.min_trade_size,
          entry_price: signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice,
          current_price: signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice,
          stop_loss: (signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice) * (1 - settings.default_stop_loss / 100),
          take_profit: Math.min((signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice) * (1 + settings.default_take_profit / 100), 0.99),
          status: 'OPEN',
          signal_confidence: signal.confidence,
          ai_rationale: signal.analyses.map(a => `[${a.model}] ${a.rationale}`).join('\n'),
          order_id: result.order_id,
          opened_at: Date.now(),
        })
        setSignals(prev => prev.map(s => s.market_id === signal.market_id ? { ...s, executed: true } : s))
      } else {
        alert(`Error: ${result.error}`)
      }
    } catch (e) {
      alert('Execution failed')
    } finally {
      setExecutingId(null)
    }
  }

  // Memoize filtered signals for performance
  const filtered = useMemo(() => {
    return signals.filter(s => {
      if (filter === 'high') return s.confidence >= 75
      if (filter === 'buy') return s.direction === 'BUY'
      if (filter === 'sell') return s.direction === 'SELL'
      return true
    })
  }, [signals, filter])

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} scanning={scanning} />

      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="AI Signals"
          subtitle={`${signals.length} signals${scanning ? ` · scanning ${progress}%` : ''}`}
          balance={portfolio.total_balance}
          totalPnL={portfolio.total_pnl}
          onRefresh={fetchAndScan}
          loading={scanning}
        />

        <main className="flex-1 p-4 space-y-4 overflow-auto">
          {/* Scan progress */}
          {scanning && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-primary animate-pulse" />
                <span className="text-sm text-foreground">Analyzing {markets.length} markets with 3 AI models...</span>
                <span className="ml-auto font-mono text-primary text-sm">{progress}%</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Error / Retry State */}
          {lastError && !scanning && (
             <div className="p-4 bg-loss/10 border border-loss/20 rounded-lg flex items-center justify-between">
               <div className="flex items-center gap-2 text-loss text-sm">
                 <AlertCircle className="w-4 h-4" />
                 <span>{lastError}</span>
               </div>
               <button onClick={handleRetry} className="flex items-center gap-1 px-3 py-1 bg-secondary border border-border rounded text-xs hover:bg-primary/10 transition">
                 <RefreshCw className="w-3 h-3" /> Retry ({retryCount})
               </button>
             </div>
          )}

          {/* Signal summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Total Signals', value: signals.length, color: 'text-foreground', bg: '' },
              { label: 'High Confidence (75%+)', value: signals.filter(s => s.confidence >= 75).length, color: 'text-profit', bg: 'bg-profit/5 border-profit/20' },
              { label: 'BUY Signals', value: signals.filter(s => s.direction === 'BUY').length, color: 'text-profit', bg: '' },
              { label: 'SELL Signals', value: signals.filter(s => s.direction === 'SELL').length, color: 'text-loss', bg: '' },
            ].map((stat) => (
              <div key={stat.label} className={cn('bg-card border border-border rounded-lg p-3', stat.bg)}>
                <p className="text-xs text-muted-foreground mb-1">{stat.label}</p>
                <p className={cn('text-2xl font-mono font-bold', stat.color)}>{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            {(['all', 'high', 'buy', 'sell'] as FilterType[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'px-3 h-8 rounded-md text-xs font-medium transition-all',
                  filter === f
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary border border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {f === 'all' ? 'All' : f === 'high' ? 'High Confidence' : f.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Signals grid + detail */}
          <div className="grid lg:grid-cols-3 gap-4">
            {/* Signal list */}
            <div className="lg:col-span-2 space-y-2">
              {filtered.map(signal => (
                <SignalCard
                  key={signal.market_id}
                  signal={signal}
                  selected={selected?.market_id === signal.market_id}
                  isAnalyzing={analyzingMarkets.has(signal.market_id)}
                  onSelect={() => setSelected(selected?.market_id === signal.market_id ? null : signal)}
                  onExecute={() => executeSignal(signal)}
                  executing={executingId === signal.market_id}
                  settings={settings}
                />
              ))}
              {filtered.length === 0 && !scanning && (
                <div className="py-12 text-center border border-dashed border-border rounded-lg">
                  <BrainCircuit className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-foreground mb-1">No signals found</p>
                  <button onClick={fetchAndScan} className="text-xs text-primary hover:underline">
                    Run AI scan
                  </button>
                </div>
              )}
            </div>

            {/* Detail panel */}
            <div>
              {selected ? (
                <SignalDetail signal={selected} settings={settings} onExecute={() => executeSignal(selected)} executing={executingId === selected.market_id} />
              ) : (
                <div className="bg-card border border-border rounded-lg p-6 text-center">
                  <BrainCircuit className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">Select a signal to see detailed AI analysis</p>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

// ─── Signal Card ──────────────────────────────────────────────────────────────

function SignalCard({
  signal,
  selected,
  isAnalyzing,
  onSelect,
  onExecute,
  executing,
  settings,
}: {
  signal: CombinedSignal
  selected: boolean
  isAnalyzing: boolean
  onSelect: () => void
  onExecute: () => void
  executing: boolean
  settings: TradingSettings
}) {
  const isHigh = signal.confidence >= settings.min_confidence
  const isExecutable = isHigh && signal.direction !== 'HOLD'

  return (
    <div
      onClick={onSelect}
      className={cn(
        'bg-card border rounded-lg p-3 cursor-pointer transition-all',
        selected ? 'border-primary' : isHigh
          ? signal.direction === 'BUY' ? 'border-profit/30' : 'border-loss/30'
          : 'border-border hover:border-border/80'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Direction icon / Analyzing loader */}
        <div className={cn(
          'mt-0.5 w-7 h-7 rounded flex items-center justify-center shrink-0',
          signal.direction === 'BUY' ? 'bg-profit/15' :
          signal.direction === 'SELL' ? 'bg-loss/15' : 'bg-secondary'
        )}>
          {isAnalyzing ? (
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
          ) : signal.direction === 'BUY' ? (
            <TrendingUp className="w-4 h-4 text-profit" />
          ) : signal.direction === 'SELL' ? (
            <TrendingDown className="w-4 h-4 text-loss" />
          ) : (
            <Activity className="w-4 h-4 text-muted-foreground" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">{signal.question}</p>
          <div className="flex items-center flex-wrap gap-2 mt-1.5">
            <span className={cn(
              'text-xs font-semibold',
              signal.direction === 'BUY' ? 'text-profit' : signal.direction === 'SELL' ? 'text-loss' : 'text-muted-foreground'
            )}>
              {signal.direction} {signal.recommendedSide}
            </span>
            <span className="text-xs text-muted-foreground font-mono">
              YES {(signal.yesPrice * 100).toFixed(0)}¢ / NO {(signal.noPrice * 100).toFixed(0)}¢
            </span>
            <span className="text-xs text-muted-foreground">{signal.analyses.length} AI models</span>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className={cn(
            'text-lg font-mono font-bold',
            signal.confidence >= 80 ? 'text-profit' :
            signal.confidence >= 65 ? 'text-chart-4' : 'text-muted-foreground'
          )}>{signal.confidence}%</p>
          {isExecutable && !signal.executed && (
            <button
              onClick={e => { e.stopPropagation(); onExecute() }}
              disabled={executing}
              className={cn(
                'mt-1 px-2 py-1 rounded text-xs font-semibold transition-all disabled:opacity-50',
                signal.direction === 'BUY'
                  ? 'bg-profit/15 text-profit hover:bg-profit/25'
                  : 'bg-loss/15 text-loss hover:bg-loss/25'
              )}
            >
              {executing ? '...' : 'Execute'}
            </button>
          )}
          {signal.executed && (
            <span className="text-xs text-profit font-medium">Executed</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Signal Detail ────────────────────────────────────────────────────────────

function SignalDetail({ signal, settings, onExecute, executing }: {
  signal: CombinedSignal
  settings: TradingSettings
  onExecute: () => void
  executing: boolean
}) {
  return (
    <div className="bg-card border border-primary/20 rounded-lg overflow-hidden sticky top-4">
      <div className={cn(
        'h-1',
        signal.direction === 'BUY' ? 'bg-profit' : signal.direction === 'SELL' ? 'bg-loss' : 'bg-muted'
      )} />
      <div className="p-4 space-y-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Market Question</p>
          <p className="text-sm font-medium text-foreground leading-relaxed">{signal.question}</p>
        </div>

        {/* Confidence meter */}
        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-muted-foreground">Ensemble Confidence</span>
            <span className="font-mono font-bold text-profit">{signal.confidence}%</span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all',
                signal.confidence >= 80 ? 'bg-profit' : signal.confidence >= 65 ? 'bg-chart-4' : 'bg-primary'
              )}
              style={{ width: `${signal.confidence}%` }}
            />
          </div>
          <div className="flex justify-between text-xs mt-1 text-muted-foreground">
            <span>0%</span>
            <span className="text-loss">75% threshold</span>
            <span>100%</span>
          </div>
        </div>

        {/* Prices */}
        <div className="grid grid-cols-2 gap-2">
          <PriceBox label="YES Price" value={`${(signal.yesPrice * 100).toFixed(1)}¢`} color="profit" />
          <PriceBox label="NO Price" value={`${(signal.noPrice * 100).toFixed(1)}¢`} color="loss" />
        </div>

        {/* Recommendation */}
        <div className={cn(
          'p-3 rounded-lg',
          signal.direction === 'BUY' ? 'bg-profit/10' : 'bg-loss/10'
        )}>
          <p className="text-xs text-muted-foreground mb-0.5">AI Recommendation</p>
          <p className={cn('text-base font-bold',
            signal.direction === 'BUY' ? 'text-profit' : 'text-loss'
          )}>
            {signal.direction === 'BUY' ? 'BUY' : 'SELL'} {signal.recommendedSide} tokens
          </p>
        </div>

        {/* AI Analyses */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">AI Model Analyses</p>
          {signal.analyses.map((a, i) => (
            <div key={i} className="bg-secondary/50 rounded p-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-primary font-semibold">{a.model}</span>
                <div className="flex items-center gap-1.5">
                  <span className={cn(
                    'text-xs font-semibold',
                    a.signal === 'BUY' ? 'text-profit' : a.signal === 'SELL' ? 'text-loss' : 'text-muted-foreground'
                  )}>{a.signal}</span>
                  <span className="text-xs text-muted-foreground">{a.confidence}%</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{a.rationale}</p>
            </div>
          ))}
        </div>

        {/* Execute button */}
        {signal.confidence >= settings.min_confidence && signal.direction !== 'HOLD' && !signal.executed && (
          <button
            onClick={onExecute}
            disabled={executing}
            className={cn(
              'w-full h-10 rounded-lg text-sm font-bold transition-all disabled:opacity-50',
              signal.direction === 'BUY'
                ? 'bg-profit text-foreground hover:bg-profit/90'
                : 'bg-loss text-foreground hover:bg-loss/90'
            )}
          >
            {executing ? 'Executing...' : `Execute ${signal.direction} — $${settings.min_trade_size} USDC`}
          </button>
        )}
        {signal.executed && (
          <div className="w-full h-10 rounded-lg bg-profit/10 border border-profit/30 flex items-center justify-center text-sm font-medium text-profit">
            Trade Executed
          </div>
        )}
      </div>
    </div>
  )
}

function PriceBox({ label, value, color }: { label: string; value: string; color: 'profit' | 'loss' }) {
  return (
    <div className={cn(
      'rounded p-2 text-center border',
      color === 'profit' ? 'bg-profit/5 border-profit/15' : 'bg-loss/5 border-loss/15'
    )}>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className={cn('text-lg font-mono font-bold', color === 'profit' ? 'text-profit' : 'text-loss')}>{value}</p>
    </div>
  )
}
