// app/api/trade/execute/route.ts
// FIX: builderCode sekarang dikirim sebagai bagian dari payload order ke CLOB.
// FIX: Crypto helpers dipindah ke clob-auth.ts (tidak duplikasi kode lagi).
// FIX: minimum_order_size divalidasi sebelum submit.
// FIX: signatureType 0 = EOA (signer = maker), 1/2 = proxy (signer = funderAddress).

import { NextResponse } from 'next/server'
import {
  buildClobHeaders,
  resolveCredentials,
  generateSalt,
  buildDomainSeparator,
  encodeOrderForSignature,
  signOrderDigest,
  hexToBytes,
} from '@/lib/clob-auth'
import { keccak_256 } from '@noble/hashes/sha3'

const CLOB_HOST      = 'https://clob.polymarket.com'
const GAMMA_HOST     = 'https://gamma-api.polymarket.com'
const CTF_EXCHANGE   = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
const NEG_RISK_CTF   = '0xC5d563A36AE78145C45a50134d48A1215220f80a'
const CHAIN_ID       = 137n

// ==============================================
// Helper: concat Uint8Arrays
// ==============================================
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

// ==============================================
// GeoBlock Check
// ==============================================
async function checkGeoBlock(): Promise<boolean> {
  try {
    const res = await fetch('https://polymarket.com/api/geoblock', { cache: 'no-store' })
    const data = await res.json()
    return data.blocked === true
  } catch {
    return false
  }
}

// ==============================================
// Build & Sign Order Payload
// ==============================================
interface OrderParams {
  privateKey:    string
  funderAddress: string
  tokenId:       string
  price:         number
  size:          number
  side:          'BUY' | 'SELL'
  signatureType: number
  negRisk:       boolean
  builderCode?:  string
}

function buildOrderPayload(params: OrderParams): any {
  const { privateKey, funderAddress, tokenId, price, size, side, signatureType, negRisk, builderCode } = params

  if (!tokenId)       throw new Error('Token ID is missing')
  if (!funderAddress) throw new Error('Funder Address is missing')
  if (!privateKey)    throw new Error('Private key is missing — cannot sign order')

  const priceNum = Number(price)
  const sizeNum  = Number(size)

  if (isNaN(priceNum) || priceNum <= 0 || priceNum >= 1) throw new Error(`Invalid price: ${price}`)
  if (isNaN(sizeNum)  || sizeNum <= 0)                   throw new Error(`Invalid size: ${size}`)

  const SCALE      = 1_000_000n
  const priceBig   = BigInt(Math.round(priceNum * 1_000_000))
  const sizeBig    = BigInt(Math.round(sizeNum  * 1_000_000))

  // BUY:  maker pays USDC (makerAmount = price * size), receives shares (takerAmount = size)
  // SELL: maker pays shares (makerAmount = size), receives USDC (takerAmount = price * size)
  const makerAmount = side === 'BUY' ? (priceBig * sizeBig) / SCALE : sizeBig
  const takerAmount = side === 'BUY' ? sizeBig                      : (priceBig * sizeBig) / SCALE

  const salt = generateSalt()

  // signatureType 0 = EOA (signer == maker == funderAddress)
  // signatureType 1/2 = Proxy/Gnosis (signer == funderAddress, maker == funderAddress)
  const signerAddress = funderAddress

  const orderStruct = {
    salt,
    maker:         funderAddress,
    signer:        signerAddress,
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

  const contract        = negRisk ? NEG_RISK_CTF : CTF_EXCHANGE
  const domainSeparator = buildDomainSeparator(contract, CHAIN_ID)
  const orderHash       = encodeOrderForSignature(orderStruct)

  // EIP-712 final digest: 0x1901 + domainSeparator + orderHash
  const digest = keccak_256(concat(
    new Uint8Array([0x19, 0x01]),
    domainSeparator,
    orderHash,
  ))

  const signature = signOrderDigest(privateKey, digest)

  // Build CLOB-compatible order object
  const order: Record<string, any> = {
    salt:          salt.toString(),
    maker:         funderAddress,
    signer:        signerAddress,
    taker:         '0x0000000000000000000000000000000000000000',
    tokenId:       tokenId,
    makerAmount:   makerAmount.toString(),
    takerAmount:   takerAmount.toString(),
    expiration:    '0',
    nonce:         '0',
    feeRateBps:    '0',
    side:          side === 'BUY' ? 0 : 1,
    signatureType,
    signature,
    orderType:     'GTC',
  }

  // FIX: Sertakan builderCode di dalam payload order agar volume teratribusi ke builder profile
  if (builderCode) {
    order.builderCode = builderCode
  }

  return { order, orderType: 'GTC' }
}

// ==============================================
// POST Handler
// ==============================================
export async function POST(request: Request) {
  try {
    // 1. GeoBlock Check
    const isBlocked = await checkGeoBlock()
    if (isBlocked) {
      return NextResponse.json({ error: 'Trading not available in your region' }, { status: 403 })
    }

    // 2. Parse Request Body
    const body = await request.json() as any
    const { market_id, side, size, price, credentials: clientCreds } = body

    if (!market_id || !side || !size || !price) {
      return NextResponse.json({
        error: 'Missing required fields: market_id, side, size, price'
      }, { status: 400 })
    }

    // 3. Resolve Credentials
    const creds = resolveCredentials(clientCreds)
    if (!creds) {
      return NextResponse.json({
        error: 'Credentials not configured. Set POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, FUNDER_ADDRESS, POLY_PRIVATE_KEY'
      }, { status: 401 })
    }

    // 4. Validate Private Key
    if (!creds.privateKey || creds.privateKey.length < 32) {
      return NextResponse.json({
        error: 'Invalid or missing private key (POLY_PRIVATE_KEY). Required for order signing.'
      }, { status: 401 })
    }

    // 5. Fetch Market Data
    const marketRes = await fetch(`${GAMMA_HOST}/markets/${market_id}`, { cache: 'no-store' })
    if (!marketRes.ok) {
      return NextResponse.json({
        error: `Failed to fetch market data: ${marketRes.status}`
      }, { status: 500 })
    }
    const market = await marketRes.json()

    // 6. Parse Token IDs
    let tokenIdsRaw = market.clobTokenIds
    if (typeof tokenIdsRaw === 'string') {
      try { tokenIdsRaw = JSON.parse(tokenIdsRaw) } catch { tokenIdsRaw = [] }
    }
    const tokenIds = Array.isArray(tokenIdsRaw) ? tokenIdsRaw : []
    if (tokenIds.length < 2) {
      return NextResponse.json({ error: 'Insufficient token IDs in market data' }, { status: 400 })
    }

    // 7. Select Token ID: YES = index 0, NO = index 1
    const tokenIdStr = side === 'YES' ? String(tokenIds[0]) : String(tokenIds[1])

    // 8. Round price to nearest tick size
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01
    const clampedPrice = parseFloat((Math.round(Number(price) / tickSize) * tickSize).toFixed(4))

    if (clampedPrice <= 0 || clampedPrice >= 1) {
      return NextResponse.json({ error: `Price out of valid range: ${clampedPrice}` }, { status: 400 })
    }

    // 9. Validate minimum order size
    const minOrderSize = parseFloat(market.minimum_order_size ?? '1')
    if (Number(size) < minOrderSize) {
      return NextResponse.json({
        error: `Order size ${size} below market minimum ${minOrderSize}`
      }, { status: 400 })
    }

    // 10. Map side: YES -> BUY, NO -> SELL
    const tradeSide: 'BUY' | 'SELL' = side === 'YES' ? 'BUY' : 'SELL'

    // 11. Build Signed Order Payload (dengan builderCode)
    const payload = buildOrderPayload({
      privateKey:    creds.privateKey,
      funderAddress: creds.funderAddress,
      tokenId:       tokenIdStr,
      price:         clampedPrice,
      size:          Number(size),
      side:          tradeSide,
      signatureType: creds.signatureType,
      negRisk:       Boolean(market.neg_risk),
      builderCode:   creds.builderCode || undefined,
    })

    // 12. Build CLOB Authentication Headers (HMAC-SHA256)
    const bodyStr    = JSON.stringify(payload)
    const authHeaders = await buildClobHeaders(creds, 'POST', '/order', bodyStr)

    // 13. Debug Log
    console.log('[api/execute] Submitting order to CLOB:')
    console.log('  Token ID      :', tokenIdStr)
    console.log('  Side          :', tradeSide)
    console.log('  Price         :', clampedPrice)
    console.log('  Size          :', size)
    console.log('  makerAmount   :', payload.order.makerAmount)
    console.log('  takerAmount   :', payload.order.takerAmount)
    console.log('  signatureType :', creds.signatureType)
    console.log('  builderCode   :', creds.builderCode || 'none')

    // 14. Submit Order to CLOB
    const orderRes = await fetch(`${CLOB_HOST}/order`, {
      method: 'POST',
      headers: authHeaders,
      body: bodyStr,
    })

    const orderData = await orderRes.json() as any

    if (!orderRes.ok) {
      console.error('[api/execute] CLOB Error:', orderRes.status, orderData)
      return NextResponse.json({
        error: orderData?.error || orderData?.message || 'Order submission failed',
        details: orderData,
      }, { status: orderRes.status })
    }

    // 15. Return success
    console.log('[api/execute] Order submitted successfully:', orderData)

    return NextResponse.json({
      success:      true,
      order_id:     orderData?.orderID ?? orderData?.order_id ?? crypto.randomUUID(),
      token_id:     tokenIdStr,
      token_ids:    tokenIds,
      condition_id: market.condition_id ?? '',
      price:        clampedPrice,
      size:         Number(size),
      side:         tradeSide,
      market_id,
      maker_amount: payload.order.makerAmount,
      taker_amount: payload.order.takerAmount,
      builder_code: creds.builderCode || null,
    })

  } catch (e: unknown) {
    console.error('[api/execute] Unexpected error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
