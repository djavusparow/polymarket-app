'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, Filter, TrendingUp, Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { MarketCard } from '@/components/market-card'
import { getSettings, calculatePortfolioStats, getCredentials } from '@/lib/trade-engine'
import { useRealtimePrices } from '@/hooks/use-realtime-prices'
import type { PolymarketMarket, CombinedSignal } from '@/lib/types'

export default function MarketsPage() {
  const [markets, setMarkets] = useState<PolymarketMarket[]>([])
  const [signals, setSignals] = useState<Record<string, CombinedSignal>>({})
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const settings = getSettings()
  const portfolio = calculatePortfolioStats()

  // Collect YES token IDs for real-time WebSocket subscription
  const tokenIds = useMemo(() => {
    const ids: string[] = []
    for (const m of markets) {
      if (m.clobTokenIds?.[0]) ids.push(m.clobTokenIds[0])
    }
    return ids
  }, [markets])

  // Real-time WebSocket price updates
  const { prices: realtimePrices, connected: wsConnected } = useRealtimePrices(tokenIds)

  const fetchMarkets = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/markets?limit=50')
      const data = await res.json()
      setMarkets(data.markets ?? [])
    } catch (e) {
      console.error('[markets] error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchMarkets() }, [fetchMarkets])

  const analyzeMarket = async (market: PolymarketMarket) => {
    setAnalyzingId(market.id)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market }),
      })
      const data = await res.json()
      if (data.signal) {
        setSignals(prev => ({ ...prev, [market.id]: data.signal }))
      }
    } catch (e) {
      console.error('[markets] analyze error:', e)
    } finally {
      setAnalyzingId(null)
    }
  }

  const handleExecute = async (signal: CombinedSignal) => {
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
        alert(`Trade executed! Order ID: ${result.order_id}`)
      } else {
        alert(`Trade failed: ${result.error}`)
      }
    } catch (e) {
      alert('Trade execution error')
    }
  }

  const categories = ['all', ...Array.from(new Set(markets.map(m => m.category).filter(Boolean) as string[]))]

  const filtered = markets.filter(m => {
    const matchSearch = !search || m.question.toLowerCase().includes(search.toLowerCase())
    const matchCat = category === 'all' || m.category === category
    return matchSearch && matchCat
  })

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} />

      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="Markets"
          subtitle={`${markets.length} active markets`}
          balance={portfolio.total_balance}
          totalPnL={portfolio.total_pnl}
          onRefresh={fetchMarkets}
          loading={loading}
        />

        <main className="flex-1 p-4 space-y-4 overflow-auto">
          {/* Search & filter bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search markets..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full h-9 bg-secondary border border-border rounded-md pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary transition-colors"
              />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              {categories.slice(0, 8).map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`px-3 h-9 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
                    category === cat
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary border border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {cat === 'all' ? 'All' : cat}
                </button>
              ))}
            </div>
          </div>

          {/* Real-time connection status */}
          <div className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium w-fit',
            wsConnected
              ? 'bg-profit/10 text-profit border border-profit/20'
              : 'bg-secondary text-muted-foreground border border-border'
          )}>
            {wsConnected
              ? <Wifi className="w-3.5 h-3.5" />
              : <WifiOff className="w-3.5 h-3.5" />}
            {wsConnected ? 'Live prices connected' : 'Connecting to live prices...'}
            {wsConnected && tokenIds.length > 0 && (
              <span className="opacity-70">{tokenIds.length} tokens</span>
            )}
          </div>

          {/* Count */}
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <span className="text-sm text-muted-foreground">
              Showing <span className="text-foreground font-medium">{filtered.length}</span> markets
              {Object.keys(signals).length > 0 && (
                <span className="ml-1">· <span className="text-primary font-medium">{Object.keys(signals).length} analyzed</span></span>
              )}
            </span>
          </div>

          {/* Markets grid */}
          {loading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="h-40 bg-secondary/50 rounded-lg border border-border animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map(market => {
                const yesTokenId = market.clobTokenIds?.[0]
                const rtPrice = yesTokenId ? realtimePrices[yesTokenId] : undefined
                const realtimeYesPrice = rtPrice?.price ?? rtPrice?.bestBid
                return (
                  <MarketCard
                    key={market.id}
                    market={market}
                    signal={signals[market.id]}
                    onAnalyze={analyzeMarket}
                    analyzing={analyzingId === market.id}
                    onExecute={handleExecute}
                    realtimeYesPrice={realtimeYesPrice}
                  />
                )
              })}
              {filtered.length === 0 && (
                <div className="col-span-full py-12 text-center text-muted-foreground">
                  No markets match your search
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
