import { NextResponse } from 'next/server'
import { ethers } from 'ethers'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

/**
 * POST /api/trade/execute
 *
 * Builds a fully EIP-712 signed limit order and submits it to Polymarket CLOB.
 *
 * Polymarket order flow (per official docs):
 *   1. Fetch market → get clobTokenIds, neg_risk, minimum_tick_size
 *   2. Build raw order struct (makerAmount, takerAmount, tokenId, signatureType …)
 *   3. Sign with EIP-712 using private key (ethers v6 TypedDataEncoder)
 *   4. POST /order with L2 HMAC auth headers + { order: signedStruct, orderType: "GTC" }
 *
 * References:
 *   https://docs.polymarket.com/trading/orders/create.md
 *   https://github.com/Polymarket/clob-client-v2
 */

const CLOB_HOST  = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'
const CHAIN_ID   = 137 // Polygon Mainnet

// CTF Exchange contract on Polygon (used for normal markets)
const CTF_EXCHANGE         = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
// Neg-risk exchange (used for markets with neg_risk = true)
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'

// EIP-712 types for Polymarket order
// Source: https://github.com/Polymarket/clob-client-v2/blob/main/src/signing/eip712.ts
const ORDER_TYPES = {
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'taker',         type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'expiration',    type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'feeRateBps',    type: 'uint256' },
    { name: 'side',          type: 'uint8'   },
    { name: 'signatureType', type: 'uint8'   },
  ],
}

function buildDomain(negRisk: boolean): Record<string, unknown> {
  return {
    name:              'Polymarket CTF Exchange',
    version:           '1',
    chainId:           CHAIN_ID,
    verifyingContract: negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE,
  }
}

/**
 * Build and sign a Polymarket limit order using ethers v6 EIP-712 TypedDataEncoder.
 * Returns the signed order payload ready for POST /order.
 */
async function buildSignedOrder(params: {
  privateKey:    string
  maker:         string      // funderAddress (proxy wallet)
  tokenId:       string
  price:         number      // 0-1 (e.g. 0.65 = 65 cents)
  size:          number      // shares to trade (USDC denominated for buys)
  side:          'BUY' | 'SELL'
  signatureType: 0 | 1 | 2
  negRisk:       boolean
}): Promise<Record<string, string | number>> {
  const {
    privateKey, maker, tokenId, price, size, side, signatureType, negRisk,
  } = params

  // Polymarket uses 1e6 (USDC 6 decimals) for all amounts
  const SCALE = 1_000_000n
  const priceBig = BigInt(Math.round(price * 1_000_000))
  const sizeBig  = BigInt(Math.round(size  * 1_000_000))

  // For BUY: you give USDC (makerAmount), receive shares (takerAmount)
  // For SELL: you give shares (makerAmount), receive USDC (takerAmount)
  const makerAmount = side === 'BUY'
    ? (priceBig * sizeBig) / SCALE   // USDC cost
    : sizeBig                         // shares to sell

  const takerAmount = side === 'BUY'
    ? sizeBig                         // shares to receive
    : (priceBig * sizeBig) / SCALE   // USDC to receive

  const salt = BigInt(Math.floor(Math.random() * 2 ** 40))

  const orderStruct = {
    salt,
    maker,
    signer:        maker,
    taker:         '0x0000000000000000000000000000000000000000',
    tokenId:       BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration:    0n,
    nonce:         0n,
    feeRateBps:    0n,
    side:          side === 'BUY' ? 0 : 1,
    signatureType,
  }

  const domain  = buildDomain(negRisk)
  const wallet  = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`)
  const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderStruct)

  return {
    salt:          salt.toString(),
    maker,
    signer:        maker,
    taker:         '0x0000000000000000000000000000000000000000',
    tokenID:       tokenId,
    makerAmount:   makerAmount.toString(),
    takerAmount:   takerAmount.toString(),
    expiration:    '0',
    nonce:         '0',
    feeRateBps:    '0',
    side,
    signatureType,
    signature,
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      market_id,
      question,
      side,
      size,
      price,
      signal_confidence,
      ai_rationale,
      stop_loss_pct,
      take_profit_pct,
      credentials: clientCreds,
    } = body

    // ── Resolve L2 API credentials ─────────────────────────────────────────────
    const creds: ClobCreds | null = resolveCredentials(clientCreds)
    if (!creds) {
      return NextResponse.json(
        { error: 'Credentials not configured. Enter your Polymarket credentials in Settings.', code: 'NO_CREDENTIALS' },
        { status: 401 }
      )
    }

    // Private key for EIP-712 signing — from env (preferred) or client
    const privateKey: string =
      process.env.POLYMARKET_PRIVATE_KEY ??
      clientCreds?.privateKey ??
      ''

    if (!privateKey) {
      return NextResponse.json(
        { error: 'POLYMARKET_PRIVATE_KEY is required for signing. Add it to Vercel Environment Variables.', code: 'NO_PRIVATE_KEY' },
        { status: 401 }
      )
    }

    // ── 1. Fetch market info ───────────────────────────────────────────────────
    const marketRes = await fetch(`${GAMMA_HOST}/markets/${market_id}`, { cache: 'no-store' })
    if (!marketRes.ok) {
      return NextResponse.json({ error: `Market ${market_id} not found` }, { status: 404 })
    }
    const market = await marketRes.json()

    const clobTokenIds: string[] = market.clobTokenIds ?? []
    if (clobTokenIds.length < 2) {
      return NextResponse.json(
        { error: 'Market not tradeable on CLOB yet (no token IDs)' },
        { status: 400 }
      )
    }

    // YES = index 0, NO = index 1
    const tokenId = side === 'YES' ? clobTokenIds[0] : clobTokenIds[1]
    const negRisk: boolean = Boolean(market.neg_risk)

    // ── 2. Fetch live tick size ────────────────────────────────────────────────
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    try {
      const tsRes = await fetch(`${CLOB_HOST}/tick-size?token_id=${encodeURIComponent(tokenId)}`)
      if (tsRes.ok) {
        const ts = await tsRes.json()
        const parsed = parseFloat(ts?.minimum_tick_size ?? ts?.tick_size ?? '0.01')
        if (parsed > 0) tickSize = parsed
      }
    } catch { /* use market fallback */ }

    // ── 3. Clamp price to valid range ─────────────────────────────────────────
    const decimals     = Math.max(0, -Math.floor(Math.log10(tickSize)))
    const roundedPrice = parseFloat(parseFloat(price).toFixed(decimals))
    const clampedPrice = Math.max(tickSize, Math.min(roundedPrice, 1 - tickSize))

    const signatureType = (creds.signatureType ?? 1) as 0 | 1 | 2

    // ── 4. Build + sign EIP-712 order ─────────────────────────────────────────
    const signedOrder = await buildSignedOrder({
      privateKey,
      maker:  creds.funderAddress,
      tokenId,
      price:  clampedPrice,
      size:   Number(size),
      side:   'BUY', // Polymarket: always BUY outcome tokens
      signatureType,
      negRisk,
    })

    // ── 5. POST signed order to CLOB with HMAC auth headers ───────────────────
    const orderPayload = JSON.stringify({ order: signedOrder, orderType: 'GTC' })
    const orderPath    = '/order'
    const authHeaders  = await buildClobHeaders(creds, 'POST', orderPath, orderPayload)

    const orderRes  = await fetch(`${CLOB_HOST}${orderPath}`, {
      method:  'POST',
      headers: authHeaders,
      body:    orderPayload,
    })
    const orderData = await orderRes.json()

    if (!orderRes.ok) {
      console.error('[trade/execute] CLOB rejected order:', orderRes.status, JSON.stringify(orderData))
      return NextResponse.json(
        { error: orderData?.error ?? orderData?.message ?? `CLOB error ${orderRes.status}` },
        { status: orderRes.status }
      )
    }

    // ── 6. Calculate stop-loss / take-profit price levels ─────────────────────
    const slPct      = Number(stop_loss_pct ?? 30)
    const tpPct      = Number(take_profit_pct ?? 80)
    const stopLoss   = parseFloat((clampedPrice * (1 - slPct / 100)).toFixed(4))
    const takeProfit = Math.min(parseFloat((clampedPrice * (1 + tpPct / 100)).toFixed(4)), 0.99)

    const orderId = orderData?.orderID ?? orderData?.order_id ?? orderData?.id ?? crypto.randomUUID()

    console.log('[trade/execute] Order placed on-chain:', {
      market: (question as string)?.slice(0, 50),
      tokenId, side, clampedPrice, size, orderId,
      confidence: signal_confidence,
    })

    return NextResponse.json({
      success:      true,
      trade_id:     crypto.randomUUID(),
      order_id:     orderId,
      condition_id: market.condition_id ?? market_id,
      token_id:     tokenId,
      status:       orderData?.status ?? 'LIVE',
      price:        clampedPrice,
      size,
      side,
      stop_loss:    stopLoss,
      take_profit:  takeProfit,
      neg_risk:     negRisk,
      ai_rationale,
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[api/trade/execute] Unhandled error:', msg)
    return NextResponse.json({ error: `Trade execution failed: ${msg}` }, { status: 500 })
  }
}
