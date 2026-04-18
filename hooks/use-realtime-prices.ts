'use client'

/**
 * Real-time price updates via Polymarket WebSocket
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * Subscribes to `best_bid_ask` and `last_trade_price` events for a list of token IDs.
 * Reconnects automatically on disconnect with exponential backoff.
 */

import { useEffect, useRef, useCallback, useState } from 'react'

const WSS_ENDPOINT = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

export interface RealtimePrice {
  tokenId: string
  price: number       // last trade price or midpoint
  bestBid: number
  bestAsk: number
  updatedAt: number
}

type PriceMap = Record<string, RealtimePrice>

export function useRealtimePrices(tokenIds: string[]) {
  const [prices, setPrices] = useState<PriceMap>({})
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriesRef = useRef(0)
  const activeTokensRef = useRef<string[]>([])

  const subscribe = useCallback((ws: WebSocket, ids: string[]) => {
    if (ws.readyState !== WebSocket.OPEN || ids.length === 0) return
    ws.send(JSON.stringify({
      assets_ids: ids,
      type: 'market',
      custom_feature_enabled: true,  // enables best_bid_ask events
    }))
  }, [])

  const connect = useCallback(() => {
    if (activeTokensRef.current.length === 0) return

    const ws = new WebSocket(WSS_ENDPOINT)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      retriesRef.current = 0
      subscribe(ws, activeTokensRef.current)
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string)
        const now = Date.now()

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
        }

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
        }

        // price_change: update specific token's bid/ask
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
        // ignore malformed messages
      }
    }

    ws.onerror = () => {
      setConnected(false)
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
      const delay = Math.min(1000 * Math.pow(2, retriesRef.current), 30_000)
      retriesRef.current += 1
      reconnectTimer.current = setTimeout(connect, delay)
    }
  }, [subscribe])

  // (Re-)connect when tokenIds change
  useEffect(() => {
    const ids = tokenIds.filter(Boolean)
    activeTokensRef.current = ids

    // If already connected and just need to subscribe to new tokens
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      subscribe(wsRef.current, ids)
      return
    }

    // Close existing before reconnect
    if (wsRef.current) {
      wsRef.current.onclose = null  // prevent auto-reconnect loop
      wsRef.current.close()
      wsRef.current = null
    }
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)

    if (ids.length > 0) connect()

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(tokenIds)])

  return { prices, connected }
}
