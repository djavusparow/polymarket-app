// app/api/trade/execute/route.ts

import { NextResponse } from 'next/server'
import { secp256k1 } from '@noble/curves/secp256k1'
import { buildClobHeaders, resolveCredentials, generateSalt } from '@/lib/clob-auth'

const CLOB_HOST  = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'

// Contract addresses
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'
const CHAIN_ID = 137n

// ==============================================
// Cryptography Helpers
// ==============================================
function keccak256(input: Uint8Array): Uint8Array {
  const RATE = 136
  const RC: [number, number][] = [
    [0x00000001,0x00000000],[0x00008082,0x00000000],[0x0000808a,0x80000000],
    [0x80008000,0x80000000],[0x0000808b,0x00000000],[0x80000001,0x00000000],
    [0x80008081,0x80000000],[0x00008009,0x80000000],[0x0000008a,0x00000000],
    [0x00000088,0x00000000],[0x80008009,0x00000000],[0x8000000a,0x00000000],
    [0x8000808b,0x00000000],[0x0000008b,0x80000000],[0x00008089,0x80000000],
    [0x00008003,0x80000000],[0x00008002,0x80000000],[0x00000080,0x80000000],
    [0x0000800a,0x00000000],[0x8000000a,0x80000000],[0x80008081,0x80000000],
    [0x00008080,0x80000000],[0x80000001,0x00000000],[0x80008008,0x80000000],
  ]
  const PILN = [10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1]
  const ROTC = [1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44]
  
  function rotl32(v: number, n: number) { return ((v << n) | (v >>> (32-n))) >>> 0 }

  const padLen = RATE - (input.length % RATE)
  const msg = new Uint8Array(input.length + padLen)
  msg.set(input)
  msg[input.length] = 0x01
  msg[msg.length - 1] |= 0x80

  const s = new Int32Array(50)
  for (let b = 0; b < msg.length; b += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      s[i*2]   ^= msg[b+i*8]   | msg[b+i*8+1]<<8 | msg[b+i*8+2]<<16 | msg[b+i*8+3]<<24
      s[i*2+1] ^= msg[b+i*8+4] | msg[b+i*8+5]<<8 | msg[b+i*8+6]<<16 | msg[b+i*8+7]<<24
    }
    for (let r = 0; r < 24; r++) {
      const c = new Int32Array(10)
      for (let x = 0; x < 10; x++) c[x] = s[x]^s[x+10]^s[x+20]^s[x+30]^s[x+40]
      for (let x = 0; x < 10; x += 2) {
        const t0 = c[(x+2)%10] ^ rotl32(c[(x+3)%10], 1)
        const t1 = c[(x+3)%10] ^ rotl32(c[(x+2)%10], 31)
        for (let y = 0; y < 50; y += 10) { s[y+x] ^= t0; s[y+x+1] ^= t1 }
      }
      let t0 = s[2], t1 = s[3]
      for (let i = 0; i < 24; i++) {
        const j = PILN[i], n = ROTC[i]
        const c0 = s[j*2], c1 = s[j*2+1]
        s[j*2]   = n < 32 ? rotl32(t0, n)    : rotl32(t1, n-32)
        s[j*2+1] = n < 32 ? rotl32(t1, n)    : rotl32(t0, n-32)
        if (i < 23) { t0 = c0; t1 = c1 }
      }
      for (let y = 0; y < 50; y += 10) {
        const t = s.slice(y, y+10)
        for (let x = 0; x < 10; x += 2) {
          s[y+x]   = t[x]   ^ (~t[(x+2)%10] & t[(x+4)%10])
          s[y+x+1] = t[x+1] ^ (~t[(x+3)%10] & t[(x+5)%10])
        }
      }
      s[0] ^= RC[r][0]; s[1] ^= RC[r][1]
    }
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    const lo = s[i*2] >>> 0, hi = s[i*2+1] >>> 0
    out[i*4]   = lo & 0xff;       out[i*4+1] = (lo>>>8) & 0xff
    out[i*4+2] = (lo>>>16) & 0xff; out[i*4+3] = (lo>>>24) & 0xff
    out[i*4+4] = hi & 0xff;       out[i*4+5] = (hi>>>8) & 0xff
    out[i*4+6] = (hi>>>16) & 0xff; out[i*4+7] = (hi>>>24) & 0xff
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i*2, i*2+2), 16)
  return out
}

function encodeUint256(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n < 0n ? (1n << 256n) + n : n
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}

function encodeAddress(addr: string): Uint8Array {
  const out = new Uint8Array(32)
  const b = hexToBytes(addr)
  out.set(b, 32 - b.length)
  return out
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

const ORDER_TYPE_STR = 'Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)'

function buildDomainSeparator(contract: string): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s)
  const tHash = keccak256(enc('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))
  const nHash = keccak256(enc('Polymarket CTF Exchange'))
  const vHash = keccak256(enc('1'))
  return keccak256(concat(tHash, nHash, vHash, encodeUint256(CHAIN_ID), encodeAddress(contract)))
}

function buildOrderHash(o: any): Uint8Array {
  const typeHash = keccak256(new TextEncoder().encode(ORDER_TYPE_STR))
  return keccak256(concat(
    typeHash,
    encodeUint256(o.salt),
    encodeAddress(o.maker), encodeAddress(o.signer), encodeAddress(o.taker),
    encodeUint256(o.tokenId), encodeUint256(o.makerAmount), encodeUint256(o.takerAmount),
    encodeUint256(o.expiration), encodeUint256(o.nonce), encodeUint256(o.feeRateBps),
    encodeUint256(BigInt(o.side)), encodeUint256(BigInt(o.signatureType)),
  ))
}

function signOrderDigest(privateKeyHex: string, digest: Uint8Array): string {
  const pkHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const sig = secp256k1.sign(digest, pkHex, { lowS: true })
  const r = sig.r.toString(16).padStart(64, '0')
  const s = sig.s.toString(16).padStart(64, '0')
  const v = sig.recovery === 0 ? '1b' : '1c'
  return `0x${r}${s}${v}`
}

// ==============================================
// GeoBlock Check
// ==============================================
async function checkGeoBlock(): Promise<boolean> {
  try {
    const res = await fetch('https://polymarket.com/api/geoblock', { cache: 'no-store' })
    const data = await res.json()
    return data.blocked === true
  } catch { return false }
}

// ==============================================
// Build Order Payload
// ==============================================
interface OrderParams {
  privateKey: string
  funderAddress: string
  tokenId: string
  price: number
  size: number
  side: 'BUY' | 'SELL'
  signatureType: number
  negRisk: boolean
  builderCode?: string
}

function buildOrderPayload(params: OrderParams): any {
  const { privateKey, funderAddress, tokenId, price, size, side, signatureType, negRisk } = params

  if (!tokenId) throw new Error('Token ID is missing')
  if (!funderAddress) throw new Error('Funder Address is missing')

  const priceNum = Number(price)
  const sizeNum = Number(size)

  if (isNaN(priceNum) || priceNum <= 0 || priceNum >= 1) throw new Error(`Invalid price: ${price}`)
  if (isNaN(sizeNum) || sizeNum <= 0) throw new Error(`Invalid size: ${size}`)

  const SCALE = 1_000_000n
  const priceBig = BigInt(Math.round(priceNum * 1_000_000))
  const sizeBig = BigInt(Math.round(sizeNum * 1_000_000))
  
  // BUY: maker pays price * size, SELL: maker pays size
  const makerAmount = side === 'BUY' ? (priceBig * sizeBig) / SCALE : sizeBig
  const takerAmount = side === 'BUY' ? sizeBig : (priceBig * sizeBig) / SCALE
  
  const salt = generateSalt()
  
  // Type 0: Signer is Proxy Wallet Address
  const signerAddress = funderAddress

  const orderStruct = {
    salt, 
    maker: funderAddress, 
    signer: signerAddress,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: BigInt(tokenId),
    makerAmount, 
    takerAmount,
    expiration: 0n, 
    nonce: 0n, 
    feeRateBps: 0n,
    side: side === 'BUY' ? 0 : 1, 
    signatureType,
  }

  // Determine contract
  const contract = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE
  
  // Build EIP-712 domain separator
  const domainSeparator = buildDomainSeparator(contract)
  
  // Build order hash
  const orderHash = buildOrderHash(orderStruct)
  
  // Build signable digest: 0x19 + 0x01 + domainSeparator + orderHash
  const digest = keccak256(concat(
    new Uint8Array([0x19, 0x01]),
    domainSeparator,
    orderHash,
  ))

  // Sign the digest
  const signature = signOrderDigest(privateKey, digest)

  // Build the final order payload
  const order = {
    salt: salt.toString(),
    maker: funderAddress,
    signer: signerAddress,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: tokenId, // String format
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    expiration: '0',
    nonce: '0',
    feeRateBps: '0',
    side: side === 'BUY' ? 0 : 1,
    signatureType,
    signature,
    orderType: 'GTC',
  }

  return { order, orderType: 'GTC' }
}

// ==============================================
// POST Handler
// ==============================================
export async function POST(request: Request) {
  try {
    // 1. GeoBlock Check (Wajib - sesuai anjuran Polymarket)
    const isBlocked = await checkGeoBlock()
    if (isBlocked) {
      return NextResponse.json({ 
        error: 'Trading not available in your region' 
      }, { status: 403 })
    }

    // 2. Parse Request Body
    const body = await request.json() as any
    const { market_id, side, size, price, credentials: clientCreds } = body

    // 3. Resolve Credentials
    const creds = resolveCredentials(clientCreds)
    if (!creds) {
      return NextResponse.json({ 
        error: 'Credentials not configured. Please set POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, FUNDER_ADDRESS, and POLY_PRIVATE_KEY' 
      }, { status: 401 })
    }

    // 4. Validate Private Key
    const privateKey = creds.privateKey
    if (!privateKey || privateKey.length < 32) {
      return NextResponse.json({ 
        error: 'Invalid private key. Please set POLY_PRIVATE_KEY environment variable.' 
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
      return NextResponse.json({ 
        error: 'Insufficient token IDs in market data' 
      }, { status: 400 })
    }

    // 7. Select Token ID based on side
    // YES = index 0, NO = index 1
    const tokenIdStr = side === 'YES' ? String(tokenIds[0]) : String(tokenIds[1])

    // 8. Calculate Price with proper tick size
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01
    
    // Round price to nearest tick size
    const clampedPrice = Math.round(Number(price) / tickSize) * tickSize
    
    if (clampedPrice <= 0 || clampedPrice >= 1) {
      return NextResponse.json({ 
        error: `Price out of valid range: ${clampedPrice}` 
      }, { status: 400 })
    }
    if (Number(size) <= 0) {
      return NextResponse.json({ 
        error: 'Size must be greater than 0' 
      }, { status: 400 })
    }

    // 9. Map Side: YES -> BUY, NO -> SELL
    const tradeSide: 'BUY' | 'SELL' = side === 'YES' ? 'BUY' : 'SELL'

    // 10. Build Order Payload
    const payload = buildOrderPayload({
      privateKey,
      funderAddress: creds.funderAddress,
      tokenId: tokenIdStr,
      price: clampedPrice,
      size: Number(size),
      side: tradeSide,
      signatureType: creds.signatureType,
      negRisk: Boolean(market.neg_risk),
    })

    // 11. Build Authentication Headers
    const bodyStr = JSON.stringify(payload)
    const authHeaders = await buildClobHeaders(creds, 'POST', '/order', bodyStr)

    // 12. Debug Log
    console.log('[api/execute] Sending order to CLOB:')
    console.log('- Token ID:', tokenIdStr)
    console.log('- Side:', tradeSide)
    console.log('- Price:', clampedPrice)
    console.log('- Size:', size)
    console.log('- Maker Amount:', payload.order.makerAmount)
    console.log('- Taker Amount:', payload.order.takerAmount)
    console.log('- Signature Type:', creds.signatureType)

    // 13. Send Order to CLOB
    const orderRes = await fetch(`${CLOB_HOST}/order`, {
      method: 'POST',
      headers: authHeaders,
      body: bodyStr,
    })

    // 14. Parse Response
    const orderData = await orderRes.json() as any
    
    if (!orderRes.ok) {
      console.error('[api/execute] CLOB Error:', orderRes.status, orderData)
      return NextResponse.json({ 
        error: orderData?.error || orderData?.message || 'Order submission failed',
        details: orderData 
      }, { status: orderRes.status })
    }

    // 15. Success Response
    console.log('[api/execute] Order submitted successfully:', orderData)
    
    return NextResponse.json({
      success: true,
      order_id: orderData?.orderID ?? orderData?.order_id ?? crypto.randomUUID(),
      token_id: tokenIdStr,
      price: clampedPrice,
      size: Number(size),
      side: tradeSide,
      market_id,
      maker_amount: payload.order.makerAmount,
      taker_amount: payload.order.takerAmount,
      builder_code: creds.builderCode || null,
    })

  } catch (e: unknown) {
    console.error('[api/execute] Unexpected Error:', e)
    return NextResponse.json({ 
      error: String(e) 
    }, { status: 500 })
  }
}
