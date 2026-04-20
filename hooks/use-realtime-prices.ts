'use client'

import { useEffect, useRef, useCallback, useState } from 'react'

const WSS_ENDPOINT = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

export interface RealtimePrice {
  tokenId: string
  price: number       // last trade price atau midpoint
  bestBid: number
  bestAsk: number
  updatedAt: number
}

type PriceMap = Record<string, RealtimePrice>

/**
 * Hook yang meng‑stream harga secara real‑time untuk sekumpulan tokenId.
 * Meng‑handle:
 *   • koneksi WebSocket dengan exponential back‑off
 *   • ping/pong dalam format JSON
 *   • subscribe satu kali (koneksi ditutup & dibuka kembali bila token list berubah)
 */
export function useRealtimePrices(tokenIds: string[]) {
  const [prices, setPrices] = useState<PriceMap>({})
  const [connected, setConnected] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const retriesRef = useRef(0)
  const activeTokensRef = useRef<string[]>([])

  /** Kirim subscription payload */
  const subscribe = useCallback((ws: WebSocket, ids: string[]) => {
    if (ws.readyState !== WebSocket.OPEN || ids.length === 0) return

    ws.send(
      JSON.stringify({
        type: 'market',
        assets_ids: ids,
        // contoh custom flag; tetap ada bila dibutuhkan.
        custom_feature_enabled: true,
      })
    )
  }, [])

  /** Membuat koneksi baru */
  const connect = useCallback(() => {
    if (activeTokensRef.current.length === 0) return

    const ws = new WebSocket(WSS_ENDPOINT)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      retriesRef.current = 0
      subscribe(ws, activeTokensRef.current)

      // heartbeat tiap 10 detik (JSON)
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current)
      heartbeatTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 10_000)
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string)
        const now = Date.now()

        // balas ping server
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }

        // best bid / ask
        if (msg.event_type === 'best_bid_ask') {
          const tokenId: string = msg.asset_id
          const bid = parseFloat(msg.best_bid ?? '0')
          const ask = parseFloat(msg.best_ask ?? '0')
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask
          setPrices(prev => ({
            ...prev,
            [tokenId]: {
              tokenId,
              price: prev[tokenId]?.price ?? mid,
              bestBid: bid,
              bestAsk: ask,
              updatedAt: now,
            },
          }))
          return
        }

        // last trade price
        if (msg.event_type === 'last_trade_price') {
          const tokenId: string = msg.asset_id
          const price = parseFloat(msg.price ?? '0')
          setPrices(prev => ({
            ...prev,
            [tokenId]: {
              tokenId,
              price,
              bestBid: prev[tokenId]?.bestBid ?? 0,
              bestAsk: prev[tokenId]?.bestAsk ?? 0,
              updatedAt: now,
            },
          }))
          return
        }

        // batch price_change
        if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
          setPrices(prev => {
            const next = { ...prev }
            for (const change of msg.price_changes) {
              const tokenId: string = change.asset_id
              const bid = parseFloat(change.best_bid ?? prev[tokenId]?.bestBid ?? '0')
              const ask = parseFloat(change.best_ask ?? prev[tokenId]?.bestAsk ?? '0')
              const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask
              next[tokenId] = {
                tokenId,
                price: prev[tokenId]?.price ?? mid,
                bestBid: bid,
                bestAsk: ask,
                updatedAt: now,
              }
            }
            return next
          })
        }
      } catch {
        // ignore malformed payloads
      }
    }

    ws.onerror = () => {
      setConnected(false)
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      if (heartbeatTimer.current) {
        clearInterval(heartbeatTimer.current)
        heartbeatTimer.current = null
      }
      // exponential back‑off: 1 s → 2 s → 4 s … max 30 s
      const delay = Math.min(1_000 * 2 ** retriesRef.current, 30_000)
      retriesRef.current += 1
      reconnectTimer.current = setTimeout(connect, delay)
    }
  }, [subscribe])

  /** Re‑connect ketika token list berubah */
  useEffect(() => {
    const ids = tokenIds.filter(Boolean)
    activeTokensRef.current = ids

    // Tutup koneksi yang ada (jika ada) sebelum membuka yang baru
    if (wsRef.current) {
      wsRef.current.onclose = null   // cegah auto‑reconnect dari onclose lama
      wsRef.current.close()
      wsRef.current = null
    }
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)

    if (ids.length > 0) connect()

    // cleanup saat unmount atau token change selanjutnya
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
    // eslint‑disable react‑hooks/exhaustive‑deps – kami meng‑stringify tokenIds untuk deps
  }, [JSON.stringify(tokenIds)])

  return { prices, connected }
}
