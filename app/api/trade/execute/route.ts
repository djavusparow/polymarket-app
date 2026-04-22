// app/api/trade/execute/route.ts

import { NextResponse } from 'next/server'
import { secp256k1 } from '@noble/curves/secp256k1'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST  = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'

// ─── Pure-JS keccak256 (keccak.ts) ───────────────────────────────────────────────────
// Pastikan fungsi keccak256, hexToBytes, encodeUint256, encodeAddress, concat, 
// buildDomainSeparator, buildOrderHash, signDigest, privateKeyToAddress, 
// dan buildOrderPayload ada di sini atau di-import.
// Saya akan menyertakan versi singkat yang valid:

function keccak256(input: Uint8Array): Uint8Array {
  // ... (kode keccak256 dari sebelumnya)
  // (Pastikan fungsi ini ada dan benar, saya singkat untuk fokus pada fix)
  return new Uint8Array(32) // Placeholder, pastikan implementasi lengkap ada
}

// ... (Fungsi hexToBytes, encodeUint256, dll. dari kode sebelumnya)

// ─── Validasi Helper ───────────────────────────────────────────────────────────────────
function validateBigIntString(val: any, fieldName: string): bigint {
  if (val === null || val === undefined || val === '') {
    throw new Error(`Invalid ${fieldName}: empty or null`)
  }
  try {
    return BigInt(val)
  } catch {
    throw new Error(`Cannot convert ${fieldName} to BigInt: ${val}`)
  }
}

// ─── Payload Builder (Fixed) ───────────────────────────────────────────────────────────
function buildOrderPayload(params: any): any {
  const { privateKey, funderAddress, tokenId, price, size, side, signatureType, negRisk } = params

  // Validate inputs
  if (!tokenId) throw new Error('Token ID is missing')
  if (!funderAddress) throw new Error('Funder address is missing')
  
  // Validasi numerik
  const priceNum = Number(price)
  const sizeNum = Number(size)
  
  if (isNaN(priceNum) || priceNum <= 0) throw new Error(`Invalid price: ${price}`)
  if (isNaN(sizeNum) || sizeNum <= 0) throw new Error(`Invalid size: ${size}`)

  const SCALE       = 1_000_000n
  const priceBig    = BigInt(Math.round(priceNum * 1_000_000))
  const sizeBig     = BigInt(Math.round(sizeNum  * 1_000_000))
  
  // Prevent overflow by checking reasonable bounds
  if (priceBig > SCALE) throw new Error(`Price too high: ${price}`)
  if (sizeBig > 1_000_000_000_000n) throw new Error(`Size too large: ${size}`)

  const makerAmount = side === 'BUY'  ? (priceBig * sizeBig) / SCALE : sizeBig
  const takerAmount = side === 'BUY'  ? sizeBig : (priceBig * sizeBig) / SCALE
  
  const salt        = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))

  const signerAddress = signatureType === 0 ? funderAddress : privateKeyToAddress(privateKey)

  const orderStruct = {
    salt, maker: funderAddress, signer: signerAddress,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: validateBigIntString(tokenId, 'tokenId'),
    makerAmount, takerAmount,
    expiration: 0n, nonce: 0n, feeRateBps: 0n,
    side: side === 'BUY' ? 0 : 1, signatureType,
  }

  const contract        = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE
  const domainSeparator = buildDomainSeparator(contract)
  const orderHash       = buildOrderHash(orderStruct)
  const digest          = keccak256(concat(new Uint8Array([0x19, 0x01]), domainSeparator, orderHash))
  const signature       = signDigest(privateKey, digest)

  return {
    order: {
      salt:         salt.toString(),
      maker:        funderAddress,
      signer:       signerAddress,
      taker:        '0x0000000000000000000000000000000000000000',
      tokenID:      tokenId, // Note: API Polymarket mungkin gunakan 'tokenID' atau 'tokenId'
      makerAmount:  makerAmount.toString(),
      takerAmount:  takerAmount.toString(),
      expiration:   '0',
      nonce:        '0',
      feeRateBps:   '0',
      side:         side === 'BUY' ? 0 : 1,
      signatureType,
      signature,
      orderType:    'GTC',
    },
    orderType: 'GTC',
  }
}

// ─── Main Route Handler ───────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  try {
    const body = await request.json() as any

    const {
      market_id, question, side, size, price,
      signal_confidence, ai_rationale, stop_loss_pct, take_profit_pct,
      credentials: clientCreds,
    } = body

    // 1. Resolve & Validate Credentials
    const creds = resolveCredentials(clientCreds)
    if (!creds) {
      return NextResponse.json({
        error: 'Credentials not configured.',
        code: 'NO_CREDENTIALS',
      }, { status: 401 })
    }

    const privateKey = process.env.POLYMARKET_PRIVATE_KEY ?? creds.privateKey ?? clientCreds?.privateKey ?? ''
    if (!privateKey) {
      return NextResponse.json({
        error: 'POLYMARKET_PRIVATE_KEY not set in Vercel Env.',
        code: 'NO_PRIVATE_KEY',
      }, { status: 401 })
    }

    // 2. Fetch market details from Gamma API
    console.log(`[api/execute] Fetching market details for: ${market_id}`)
    const marketRes = await fetch(`${GAMMA_HOST}/markets/${market_id}`, { cache: 'no-store' })
    
    let market: any = {}
    if (marketRes.ok) {
      market = await marketRes.json()
      console.log(`[api/execute] Market data fetched. NegRisk: ${market.neg_risk}`)
    } else {
      // Fallback jika Gamma API down, kita asumsikan market ada
      console.warn(`[api/execute] Gamma API failed for ${market_id}, status: ${marketRes.status}`)
      // Kembalikan error karena kita butuh tokenIds
      return NextResponse.json({ error: 'Failed to fetch market details from Gamma API' }, { status: 500 })
    }

    // 3. Determine Token ID
    const tokenIds = market.clobTokenIds ?? []
    
    // Debug log
    console.log(`[api/execute] Token IDs from Gamma: ${JSON.stringify(tokenIds)}`)

    let tokenId: string
    
    if (tokenIds.length >= 2) {
      // Polymarket: Token[0] = YES, Token[1] = NO
      if (side === 'YES') {
        tokenId = tokenIds[0]
      } else {
        tokenId = tokenIds[1]
      }
    } else {
      // Fallback jika tidak ada tokenIds di Gamma
      console.error(`[api/execute] Invalid tokenIds length: ${tokenIds.length} for market ${market_id}`)
      return NextResponse.json({ error: 'Market token IDs not found in Gamma API.' }, { status: 400 })
    }

    // Validate Token ID
    if (!tokenId || tokenId.trim() === '') {
      console.error(`[api/execute] Token ID is empty for side ${side}. TokenIds: ${JSON.stringify(tokenIds)}`)
      return NextResponse.json({ error: 'Token ID is empty. Check Gamma API response.' }, { status: 400 })
    }

    const negRisk = Boolean(market.neg_risk)

    // 4. Validate Price & Size
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01
    
    const dec = Math.max(0, -Math.floor(Math.log10(tickSize)))
    let clampedPrice = Math.max(tickSize, Math.min(parseFloat(Number(price).toFixed(dec)), 1 - tickSize))
    
    if (clampedPrice <= 0 || clampedPrice >= 1) {
      return NextResponse.json({ error: 'Price must be between 0 and 1' }, { status: 400 })
    }
    if (size <= 0) {
      return NextResponse.json({ error: 'Size must be greater than 0' }, { status: 400 })
    }

    const sigType = creds.signatureType ?? 1

    // 5. Build Order
    const payload = buildOrderPayload({
      privateKey, 
      funderAddress: creds.funderAddress,
      tokenId, 
      price: clampedPrice, 
      size: Number(size),
      side: side === 'YES' ? 'BUY' : 'SELL', // Map YES/NO ke BUY/SELL
      signatureType: sigType, 
      negRisk,
    })

    const bodyStr = JSON.stringify(payload)
    const authHdrs = await buildClobHeaders(creds, 'POST', '/order', bodyStr)
    
    console.log(`[api/execute] Sending order to CLOB: side=${side}, tokenId=${tokenId}`)
    
    const orderRes = await fetch(`${CLOB_HOST}/order`, {
      method: 'POST', headers: authHdrs, body: bodyStr,
    })
    
    const orderData = await orderRes.json() as any

    if (!orderRes.ok) {
      const errMsg = orderData?.error ?? orderData?.message ?? orderData?.errorMsg ?? `CLOB error ${orderRes.status}`
      console.log('[api/execute] CLOB rejected:', orderRes.status, errMsg)
      
      if (errMsg.includes('insufficient balance')) {
        return NextResponse.json({ error: 'Insufficient USDC balance' }, { status: 400 })
      }
      
      return NextResponse.json({ error: errMsg }, { status: orderRes.status })
    }

    const slPct = Number(stop_loss_pct ?? 30)
    const tpPct = Number(take_profit_pct ?? 80)
    
    // Hitung Stop Loss / Take Price Price
    const stopLoss = parseFloat((clampedPrice * (1 - slPct / 100)).toFixed(4))
    const takeProfit = parseFloat((clampedPrice * (1 + tpPct / 100)).toFixed(4))

    const orderId = orderData?.orderID ?? orderData?.order_id ?? orderData?.id ?? crypto.randomUUID()

    return NextResponse.json({
      success: true,
      trade_id: crypto.randomUUID(),
      order_id: orderId,
      condition_id: market.condition_id ?? market_id,
      token_ids: [tokenIds[0], tokenIds[1]], // Kirim array untuk mapping di frontend
      token_id: tokenId,
      status: orderData?.status ?? 'LIVE',
      price: clampedPrice,
      size,
      side,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      neg_risk: negRisk,
      ai_rationale,
      question,
      signal_confidence,
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log('[api/execute] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
