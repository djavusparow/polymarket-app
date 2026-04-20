'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Wallet, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { PortfolioStatsBar } from '@/components/portfolio-stats'
import {
  getSettings,
  getOpenTrades,
  calculatePortfolioStats,
  updateTrade,
  getCredentials,
} from '@/lib/trade-engine'
import type { Trade, PortfolioStats } from '@/lib/types'

export default function PortfolioPage() {
  const [openTrades, setOpenTrades] = useState<Trade[]>([])
  const [portfolio, setPortfolio] = useState<PortfolioStats>(calculatePortfolioStats())
  const [liveBalance, setLiveBalance] = useState<number | null>(null)
  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const settings = getSettings()

  // Refs for AbortController and Debouncing
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Data Fetching Logic ─────────────────────────────────────────────────
  const fetchData = useCallback(async (isManual = false) => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort()
    }
    abortRef.current = new AbortController()

    // Debounce logic
    if (isManual && debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    if (isManual) {
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
      }, 500)
    }

    setLoading(true)
    setFetchError(null)

    try {
      const storedCreds = getCredentials()
      const headers: Record<string, string> = {}
      
      if (storedCreds?.api_key) {
        headers['X-Clob-Creds'] = JSON.stringify({
          apiKey: storedCreds.api_key,
          apiSecret: storedCreds.api_secret,
          apiPassphrase: storedCreds.api_passphrase,
          funderAddress: storedCreds.funder_address,
          // Perbaikan: Default signature type ke 0 (EOA) sesuai dokumentasi
          signatureType: storedCreds.signature_type ?? 0,
        })
      }

      const res = await fetch('/api/portfolio', {
        headers,
        signal: abortRef.current.signal,
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.error ?? 'Failed to fetch portfolio data')
      }

      console.log('[portfolio] API response:', JSON.stringify(data))

      // Update local state dengan data terbaru
      setOpenTrades(getOpenTrades())
      setPortfolio(calculatePortfolioStats())
      setConfigured(data.configured)

      if (data.configured) {
        setLiveBalance(data.balance ?? 0)
      } else {
        setLiveBalance(null)
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return // Ignore cancelled requests
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[portfolio] fetch error:', msg)
      setFetchError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Refresh Wrapper ──────────────────────────────────────────────────────
  const refresh = useCallback((isManual = false) => {
    fetchData(isManual)
  }, [fetchData])

  // ── Auto-refresh & Cleanup ───────────────────────────────────────────────
  useEffect(() => {
    // Initial fetch
    refresh()

    // Auto-refresh every 15 seconds
    const interval = setInterval(() => refresh(false), 15_000)

    return () => {
      clearInterval(interval)
      if (abortRef.current) {
        abortRef.current.abort()
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [refresh])

  // ── Close Position Logic ─────────────────────────────────────────────────
  const closePosition = useCallback((trade: Trade) => {
    // Perbaikan: Gunakan formula P&L yang konsisten dengan trade-engine
    const currentPrice = trade.current_price ?? trade.entry_price
    const shares = trade.size / trade.entry_price
    const pnl = (currentPrice - trade.entry_price) * shares

    updateTrade(trade.id, {
      status: 'CLOSED',
      exit_price: currentPrice,
      pnl: pnl,
      closed_at: Date.now(),
    })

    // Update UI local state
    setOpenTrades(getOpenTrades())
    setPortfolio(calculatePortfolioStats())
  }, [])

  const displayBalance = liveBalance ?? portfolio.total_balance

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} />

      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="Portfolio"
          subtitle="Balance & active positions"
          balance={displayBalance}
          totalPnL={portfolio.total_pnl}
          onRefresh={() => refresh(true)}
        />

        <main className="flex-1 p-4 space-y-4 overflow-auto">
          {/* Credentials notice */}
          {!configured && (
            <div className="flex items-start gap-3 p-4 bg-chart-4/10 border border-chart-4/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-chart-4 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Live data unavailable
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Configure your Polymarket API credentials in{' '}
                  <a href="/settings" className="text-primary underline">
                    Settings
                  </a>{' '}
                  to see live balance and positions.
                </p>
              </div>
            </div>
          )}

          {/* Error notice */}
          {fetchError && (
            <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Failed to fetch portfolio data
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{fetchError}</p>
              </div>
            </div>
          )}

          {/* Portfolio stats */}
          <PortfolioStatsBar
            stats={{
              ...portfolio,
              total_balance: displayBalance,
              available_balance: displayBalance,
            }}
          />

          {/* P&L chart placeholder */}
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-foreground">P&amp;L Overview</h3>
              <div className="flex items-center gap-3 text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-profit" />
                  <span className="text-muted-foreground">Profit</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-loss" />
                  <span className="text-muted-foreground">Loss</span>
                </div>
              </div>
            </div>
            <MiniPnLChart trades={openTrades} totalPnl={portfolio.total_pnl} />
          </div>

          {/* Open positions */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">Open Positions</h3>
                {loading && (
                  <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
                )}
              </div>
              <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                {openTrades.length} positions
              </span>
            </div>

            {openTrades.length === 0 ? (
              <div className="py-12 text-center">
                <Wallet className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm font-medium text-foreground mb-1">
                  No open positions
                </p>
                <p className="text-xs text-muted-foreground">
                  Execute trades from the{' '}
                  <a href="/signals" className="text-primary">
                    Signals page
                  </a>
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-4 py-2.5 text-left text-xs text-muted-foreground font-medium">
                        Market
                      </th>
                      <th className="px-3 py-2.5 text-center text-xs text-muted-foreground font-medium">
                        Side
                      </th>
                      <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">
                        Size
                      </th>
                      <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">
                        Entry
                      </th>
                      <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">
                        Stop Loss
                      </th>
                      <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">
                        Take Profit
                      </th>
                      <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">
                        P&amp;L
                      </th>
                      <th className="px-3 py-2.5 text-center text-xs text-muted-foreground font-medium">
                        Confidence
                      </th>
                      <th className="px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {openTrades.map((trade) => {
                      const pnl = trade.pnl ?? 0
                      return (
                        <tr
                          key={trade.id}
                          className="border-b border-border/50 hover:bg-secondary/20 transition-colors"
                        >
                          <td className="px-4 py-3">
                            <p className="text-xs font-medium text-foreground max-w-[220px] truncate">
                              {trade.question}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {new Date(trade.opened_at).toLocaleDateString()}
                            </p>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span
                              className={cn(
                                'text-xs font-semibold px-2 py-0.5 rounded',
                                trade.side === 'YES'
                                  ? 'bg-profit/10 text-profit'
                                  : 'bg-loss/10 text-loss'
                              )}
                            >
                              {trade.side}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className="text-xs font-mono text-foreground">
                              ${trade.size}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className="text-xs font-mono text-foreground">
                              {(trade.entry_price * 100).toFixed(1)}¢
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className="text-xs font-mono text-loss">
                              {trade.stop_loss
                                ? `${(trade.stop_loss * 100).toFixed(1)}¢`
                                : '—'}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className="text-xs font-mono text-profit">
                              {trade.take_profit
                                ? `${(trade.take_profit * 100).toFixed(1)}¢`
                                : '—'}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span
                              className={cn(
                                'text-xs font-mono font-semibold',
                                pnl >= 0 ? 'text-profit' : 'text-loss'
                              )}
                            >
                              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className="text-xs font-mono text-primary">
                              {trade.signal_confidence}%
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <button
                              onClick={() => closePosition(trade)}
                              className="px-2 py-1 text-xs rounded border border-loss/30 text-loss hover:bg-loss/10 transition-all"
                            >
                              Close
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

// ─── Mini P&L Chart ───────────────────────────────────────────────────────────

function MiniPnLChart({
  trades,
  totalPnl,
}: {
  trades: Trade[]
  totalPnl: number
}) {
  if (trades.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center border border-dashed border-border rounded-lg">
        <p className="text-xs text-muted-foreground">No trade data to display</p>
      </div>
    )
  }

  const pnls = trades.map((t) => t.pnl ?? 0)
  const maxAbs = Math.max(
    Math.abs(Math.min(...pnls)),
    Math.abs(Math.max(...pnls)),
    1
  )

  return (
    <div className="h-32 flex items-end gap-1.5 px-2">
      {pnls.slice(0, 20).map((pnl, i) => {
        const h = Math.abs(pnl / maxAbs) * 50
        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center justify-center h-full"
          >
            {pnl >= 0 ? (
              <>
                <div
                  className="w-full bg-profit/60 rounded-t"
                  style={{
                    height: `${h}%`,
                    marginBottom: 'auto',
                    maxHeight: '50%',
                  }}
                />
                <div className="h-px w-full bg-border" />
                <div className="flex-1" />
              </>
            ) : (
              <>
                <div className="flex-1" />
                <div className="h-px w-full bg-border" />
                <div
                  className="w-full bg-loss/60 rounded-b"
                  style={{
                    height: `${h}%`,
                    marginTop: 'auto',
                    maxHeight: '50%',
                  }}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
