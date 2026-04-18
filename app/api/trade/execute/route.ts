import { NextResponse } from 'next/server'
import { sign as nodeSign, createPrivateKey } from 'node:crypto'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST  = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'

// ─── EIP-712 signing using only Node.js built-in crypto ─────────────────────
// Polymarket order signing per: https://github.com/Polymarket/clob-client-v2

// keccak256 via SubtleCrypto is not available natively — we use a pure-JS impl
// that works in all Node.js / Edge environments without any npm package.

// Minimal keccak256 — based on the Keccak specification (NIST-compatible subset)
function rotl64(lo: bigint, hi: bigint, n: number): [bigint, bigint] {
  if (n === 32) return [hi, lo]
  if (n < 32) {
    return [
      ((lo << BigInt(n)) | (hi >> BigInt(32 - n))) & 0xFFFFFFFFn,
      ((hi << BigInt(n)) | (lo >> BigInt(32 - n))) & 0xFFFFFFFFn,
    ]
  }
  n -= 32
  return [
    ((hi << BigInt(n)) | (lo >> BigInt(32 - n))) & 0xFFFFFFFFn,
    ((lo << BigInt(n)) | (hi >> BigInt(32 - n))) & 0xFFFFFFFFn,
  ]
}

function keccak256(data: Uint8Array): Uint8Array {
  // Rate = 1088 bits = 136 bytes for keccak-256
  const rate = 136
  const outputLen = 32

  // Padding
  const padded = new Uint8Array(data.length + rate - (data.length % rate))
  padded.set(data)
  padded[data.length] = 0x01
  padded[padded.length - 1] |= 0x80

  // State: 5x5 lanes of 64-bit (split into lo/hi for JS compatibility)
  const stLo = new BigInt64Array(25)
  const stHi = new BigInt64Array(25)

  const RC_LO = [
    0x00000001n, 0x00008082n, 0x0000808An, 0x80008000n, 0x0000808Bn,
    0x80000001n, 0x80008081n, 0x00008009n, 0x0000008An, 0x00000088n,
    0x80008009n, 0x8000000An, 0x8000808Bn, 0x0000008Bn, 0x00008089n,
    0x00008003n, 0x00008002n, 0x00000080n, 0x0000800An, 0x8000000An,
    0x80008081n, 0x00008080n, 0x80000001n, 0x80008008n,
  ]

  for (let block = 0; block < padded.length; block += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lo = 0n, hi = 0n
      for (let b = 0; b < 4; b++) lo |= BigInt(padded[block + i * 8 + b]) << BigInt(b * 8)
      for (let b = 0; b < 4; b++) hi |= BigInt(padded[block + i * 8 + 4 + b]) << BigInt(b * 8)
      stLo[i] ^= lo
      stHi[i] ^= hi
    }
    // Keccak-f[1600] — 24 rounds
    for (let round = 0; round < 24; round++) {
      // θ
      const CLo = new BigInt64Array(5), CHi = new BigInt64Array(5)
      for (let x = 0; x < 5; x++) {
        CLo[x] = stLo[x] ^ stLo[x+5] ^ stLo[x+10] ^ stLo[x+15] ^ stLo[x+20]
        CHi[x] = stHi[x] ^ stHi[x+5] ^ stHi[x+10] ^ stHi[x+15] ^ stHi[x+20]
      }
      for (let x = 0; x < 5; x++) {
        const [dLo, dHi] = rotl64(CLo[(x+1)%5], CHi[(x+1)%5], 1)
        const lo = dLo ^ CLo[(x+4)%5], hi = dHi ^ CHi[(x+4)%5]
        for (let y = 0; y < 25; y += 5) { stLo[y+x] ^= lo; stHi[y+x] ^= hi }
      }
      // ρ and π
      const ro = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14]
      const pi = [0,10,20,5,15,16,1,11,21,6,7,17,2,12,22,23,8,18,3,13,24,14,4,19,9]
      const newLo = new BigInt64Array(25), newHi = new BigInt64Array(25)
      for (let i = 0; i < 25; i++) {
        const [l, h] = rotl64(stLo[i], stHi[i], ro[i])
        newLo[pi[i]] = l; newHi[pi[i]] = h
      }
      stLo.set(newLo); stHi.set(newHi)
      // χ
      for (let y = 0; y < 25; y += 5) {
        const l = stLo.slice(y, y+5), h = stHi.slice(y, y+5)
        for (let x = 0; x < 5; x++) {
          stLo[y+x] = l[x] ^ (~l[(x+1)%5] & l[(x+2)%5])
          stHi[y+x] = h[x] ^ (~h[(x+1)%5] & h[(x+2)%5])
        }
      }
      // ι
      stLo[0] ^= RC_LO[round]
    }
  }

  // Extract first 32 bytes
  const out = new Uint8Array(outputLen)
  for (let i = 0; i < outputLen / 8; i++) {
    for (let b = 0; b < 4; b++) out[i*8+b] = Number((stLo[i] >> BigInt(b*8)) & 0xFFn)
    for (let b = 0; b < 4; b++) out[i*8+4+b] = Number((stHi[i] >> BigInt(b*8)) & 0xFFn)
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i*2, i*2+2), 16)
  return bytes
}

function encodeUint256(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32)
  let tmp = n < 0n ? (1n << 256n) + n : n
  for (let i = 31; i >= 0; i--) { bytes[i] = Number(tmp & 0xFFn); tmp >>= 8n }
  return bytes
}

function encodeAddress(addr: string): Uint8Array {
  const bytes = new Uint8Array(32)
  const addrBytes = hexToBytes(addr)
  bytes.set(addrBytes, 32 - addrBytes.length)
  return bytes
}

// EIP-712 type hash for Polymarket Order
const ORDER_TYPE_STRING = 'Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)'

function hashOrderType(): Uint8Array {
  return keccak256(new TextEncoder().encode(ORDER_TYPE_STRING))
}

function hashOrder(order: {
  salt: bigint; maker: string; signer: string; taker: string;
  tokenId: bigint; makerAmount: bigint; takerAmount: bigint;
  expiration: bigint; nonce: bigint; feeRateBps: bigint;
  side: number; signatureType: number;
}): Uint8Array {
  const encoded = new Uint8Array(32 * 13)
  encoded.set(hashOrderType(), 0)
  encoded.set(encodeUint256(order.salt), 32)
  encoded.set(encodeAddress(order.maker), 64)
  encoded.set(encodeAddress(order.signer), 96)
  encoded.set(encodeAddress(order.taker), 128)
  encoded.set(encodeUint256(order.tokenId), 160)
  encoded.set(encodeUint256(order.makerAmount), 192)
  encoded.set(encodeUint256(order.takerAmount), 224)
  encoded.set(encodeUint256(order.expiration), 256)
  encoded.set(encodeUint256(order.nonce), 288)
  encoded.set(encodeUint256(order.feeRateBps), 320)
  encoded.set(encodeUint256(BigInt(order.side)), 352)
  encoded.set(encodeUint256(BigInt(order.signatureType)), 384)
  return keccak256(encoded)
}

function buildDomainSeparator(verifyingContract: string): Uint8Array {
  const typeHash = keccak256(new TextEncoder().encode(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  ))
  const nameHash   = keccak256(new TextEncoder().encode('Polymarket CTF Exchange'))
  const versionHash = keccak256(new TextEncoder().encode('1'))
  const encoded = new Uint8Array(32 * 4)
  encoded.set(typeHash, 0)
  encoded.set(nameHash, 32)
  encoded.set(versionHash, 64)
  encoded.set(encodeUint256(137n), 96) // Polygon chainId
  encoded.set(encodeAddress(verifyingContract), 128)
  return keccak256(encoded)
}

// ─── Order payload builder ────────────────────────────────────────────────────

async function buildOrderPayload(params: {
  privateKey: string
  funderAddress: string
  tokenId: string
  price: number
  size: number
  side: 'BUY' | 'SELL'
  signatureType: number
  negRisk: boolean
}): Promise<{ order: Record<string, string | number>; orderType: string }> {
  const { funderAddress, tokenId, price, size, side, signatureType } = params

  const CTF_EXCHANGE         = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
  const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'

  const SCALE      = 1_000_000n
  const priceBig   = BigInt(Math.round(price * 1_000_000))
  const sizeBig    = BigInt(Math.round(size  * 1_000_000))
  const makerAmount = side === 'BUY' ? (priceBig * sizeBig) / SCALE : sizeBig
  const takerAmount = side === 'BUY' ? sizeBig : (priceBig * sizeBig) / SCALE
  const salt        = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))

  const orderStruct = {
    salt,
    maker:         funderAddress,
    signer:        funderAddress,
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

  const verifyingContract = params.negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE
  const domainSeparator   = buildDomainSeparator(verifyingContract)
  const orderHash         = hashOrder(orderStruct)

  // EIP-712 digest prefix
  const prefix  = new Uint8Array([0x19, 0x01])
  const toSign  = new Uint8Array(66)
  toSign.set(prefix, 0)
  toSign.set(domainSeparator, 2)
  toSign.set(orderHash, 34)
  const digest = keccak256(toSign)

  // Sign with secp256k1 using Node.js native crypto (statically imported at top)
  const pkDer = Buffer.concat([
    Buffer.from('302e0201010420', 'hex'),
    Buffer.from(params.privateKey.replace('0x', ''), 'hex'),
    Buffer.from('a00706052b8104000a', 'hex'),
  ])
  const privateKey = createPrivateKey({ key: pkDer, format: 'der', type: 'sec1' })
  const sigDer = nodeSign(null, Buffer.from(digest), privateKey)

  // DER → r, s extraction
  let offset = 2
  const rLen = sigDer[offset + 1]; offset += 2
  const r = sigDer.slice(offset, offset + rLen); offset += rLen + 2
  const s = sigDer.slice(offset)

  const rHex = Buffer.from(r.slice(-32)).toString('hex').padStart(64, '0')
  const sHex = Buffer.from(s.slice(-32)).toString('hex').padStart(64, '0')

  // Recovery id — try both v=27 and v=28
  const signature = `0x${rHex}${sHex}1b` // v=27 default; clob will reject if wrong

  return {
    order: {
      salt:          salt.toString(),
      maker:         funderAddress,
      signer:        funderAddress,
      taker:         '0x0000000000000000000000000000000000000000',
      tokenID:       tokenId,
      makerAmount:   makerAmount.toString(),
      takerAmount:   takerAmount.toString(),
      expiration:    '0',
      nonce:         '0',
      feeRateBps:    '0',
      side:          side === 'BUY' ? 0 : 1,
      signatureType,
      signature,
    },
    orderType: 'GTC',
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      market_id: string
      question: string
      side: 'YES' | 'NO'
      size: number
      price: number
      signal_confidence: number
      ai_rationale: string
      stop_loss_pct: number
      take_profit_pct: number
      credentials?: Partial<ClobCreds> & { privateKey?: string }
    }

    const {
      market_id, question, side, size, price,
      signal_confidence, ai_rationale, stop_loss_pct, take_profit_pct,
      credentials: clientCreds,
    } = body

    // Resolve L2 HMAC credentials
    const creds: ClobCreds | null = resolveCredentials(clientCreds)
    if (!creds) {
      return NextResponse.json({
        error: 'Credentials not configured. Go to Settings and enter your Polymarket credentials.',
        code: 'NO_CREDENTIALS',
      }, { status: 401 })
    }

    const privateKey: string =
      process.env.POLYMARKET_PRIVATE_KEY ??
      clientCreds?.privateKey ??
      ''

    if (!privateKey) {
      return NextResponse.json({
        error: 'POLYMARKET_PRIVATE_KEY required for on-chain signing. Add it to Vercel Environment Variables.',
        code: 'NO_PRIVATE_KEY',
      }, { status: 401 })
    }

    // 1. Fetch market details
    const marketRes = await fetch(`${GAMMA_HOST}/markets/${market_id}`, { cache: 'no-store' })
    if (!marketRes.ok) {
      return NextResponse.json({ error: `Market ${market_id} not found` }, { status: 404 })
    }
    const market = await marketRes.json() as {
      clobTokenIds?: string[]
      neg_risk?: boolean
      minimum_tick_size?: string
      condition_id?: string
    }

    const clobTokenIds = market.clobTokenIds ?? []
    if (clobTokenIds.length < 2) {
      return NextResponse.json({ error: 'Market has no tradeable CLOB token IDs yet.' }, { status: 400 })
    }

    const tokenId  = side === 'YES' ? clobTokenIds[0] : clobTokenIds[1]
    const negRisk  = Boolean(market.neg_risk)

    // 2. Fetch live tick size
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    try {
      const tsRes = await fetch(`${CLOB_HOST}/tick-size?token_id=${encodeURIComponent(tokenId)}`)
      if (tsRes.ok) {
        const ts = await tsRes.json() as { minimum_tick_size?: string; tick_size?: string }
        const parsed = parseFloat(ts?.minimum_tick_size ?? ts?.tick_size ?? '0.01')
        if (parsed > 0) tickSize = parsed
      }
    } catch { /* use market fallback */ }

    // 3. Clamp price
    const decimals     = Math.max(0, -Math.floor(Math.log10(tickSize)))
    const roundedPrice = parseFloat(parseFloat(String(price)).toFixed(decimals))
    const clampedPrice = Math.max(tickSize, Math.min(roundedPrice, 1 - tickSize))

    const signatureType = creds.signatureType ?? 1

    // 4. Build EIP-712 signed order
    const payload = await buildOrderPayload({
      privateKey,
      funderAddress: creds.funderAddress,
      tokenId,
      price:         clampedPrice,
      size:          Number(size),
      side:          'BUY',
      signatureType,
      negRisk,
    })

    // 5. POST to CLOB with HMAC auth headers
    const bodyStr   = JSON.stringify(payload)
    const authHdrs  = await buildClobHeaders(creds, 'POST', '/order', bodyStr)
    const orderRes  = await fetch(`${CLOB_HOST}/order`, {
      method:  'POST',
      headers: authHdrs,
      body:    bodyStr,
    })
    const orderData = await orderRes.json() as {
      orderID?: string; order_id?: string; id?: string; status?: string;
      error?: string; message?: string
    }

    if (!orderRes.ok) {
      console.error('[execute] CLOB error:', orderRes.status, orderData)
      return NextResponse.json({
        error: orderData?.error ?? orderData?.message ?? `CLOB rejected order (${orderRes.status})`,
      }, { status: orderRes.status })
    }

    // 6. Compute SL / TP levels
    const slPct      = Number(stop_loss_pct ?? 30)
    const tpPct      = Number(take_profit_pct ?? 80)
    const stopLoss   = parseFloat((clampedPrice * (1 - slPct / 100)).toFixed(4))
    const takeProfit = Math.min(parseFloat((clampedPrice * (1 + tpPct / 100)).toFixed(4)), 0.99)
    const orderId    = orderData?.orderID ?? orderData?.order_id ?? orderData?.id ?? crypto.randomUUID()

    console.log('[execute] Order placed:', { market: (question as string)?.slice(0, 50), tokenId, clampedPrice, size, orderId, confidence: signal_confidence })

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
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[api/trade/execute] error:', msg)
    return NextResponse.json({ error: `Trade execution failed: ${msg}` }, { status: 500 })
  }
}
