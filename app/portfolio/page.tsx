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
  
  // PERBAIKAN 1: Inisialisasi default balance 0, bukan dari calculatePortfolioStats() yang mungkin outdated
  const [portfolio, setPortfolio] = useState<PortfolioStats>({
    total_balance: 0,
    available_balance: 0,
    total_value: 0,
    total_pnl: 0,
    total_pnl_pct: 0,
    today_pnl: 0,
    today_trades: 0,
    win_rate: 0,
    open_positions: 0,
  })
  
  const [liveBalance, setLiveBalance] = useState<number | null>(null)
  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const settings = getSettings()
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchData = useCallback(async (isManual = false) => {
    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()

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
          signatureType: storedCreds.signature_type ?? 0,
        })
      }

      const res = await fetch('/api/portfolio', {
        headers,
        signal: abortRef.current.signal,
      })
      
      // PERBAIKAN 2: Validasi response sebelum parse JSON
      if (!res.ok) {
        const errorData = await res.text()
        throw new Error(errorData || 'Failed to fetch portfolio data')
      }

      const data = await res.json()
      console.log('[portfolio] API response:', data)

      // PERBAIKAN 3: Update state berdasarkan data API, bukan local calculation
      // Data dari API biasanya sudah mencakup balance aktual
      setPortfolio(data.stats || data) 
      setConfigured(data.configured ?? true)

      // Jika API mengembalikan balance spesifik, gunakan itu
      if (data.balance !== undefined) {
        setLiveBalance(data.balance)
      } else if (data.stats?.total_balance !== undefined) {
        setLiveBalance(data.stats.total_balance)
      }

      // Update trades lokal berdasarkan API (opsional, jika API menyediakan open trades)
      if (data.openTrades) {
        setOpenTrades(data.openTrades)
      } else {
        // Fallback ke local storage jika API tidak mengembalikan trades
        setOpenTrades(getOpenTrades())
      }
      
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[portfolio] fetch error:', msg)
      setFetchError(msg)
      
      // Jika fetch gagal, tetap hitung dari local storage sebagai fallback
      setOpenTrades(getOpenTrades())
      setPortfolio(calculatePortfolioStats())
    } finally {
      setLoading(false)
    }
  }, [])

  // ... (Refresh dan useEffect tetap sama)
  const refresh = useCallback((isManual = false) => {
    fetchData(isManual)
  }, [fetchData])

  useEffect(() => {
    refresh()
    const interval = setInterval(() => refresh(false), 15_000)
    return () => {
      clearInterval(interval)
      if (abortRef.current) abortRef.current.abort()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [refresh])

  // ... (Close position dan render tetap sama, pastikan displayBalance menggunakan liveBalance atau portfolio.total_balance)
  
  // Gunakan liveBalance jika tersedia, otherwise fallback ke portfolio
  const displayBalance = liveBalance ?? portfolio.total_balance

  return (
    // ... (Render tetap sama seperti kode Anda)
    // Pastikan di render Anda menggunakan displayBalance yang sudah diperbaiki ini
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} />
      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="Portfolio"
          subtitle="Balance & active positions"
          balance={displayBalance} // Menggunakan variabel yang sudah diperbaiki
          totalPnL={portfolio.total_pnl}
          onRefresh={() => refresh(true)}
        />
        {/* ... sisa kode */}
        <main className="flex-1 p-4 space-y-4 overflow-auto">
           {/* ... sisa kode */}
           <PortfolioStatsBar
            stats={{
              ...portfolio,
              total_balance: displayBalance,
              available_balance: displayBalance, // Pastikan ini juga mengikuti live balance
            }}
           />
           {/* ... sisa kode */}
        </main>
      </div>
    </div>
  )
}

// MiniPnLChart tetap sama
function MiniPnLChart({...}) { ... }
