// app/api/trade/execute/route.ts

import { NextResponse } from 'next/server'
import { secp256k1 } from '@noble/curves/secp256k1'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST  = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'

// ─── Pure-JS keccak256 ────────────────────────────────────────────────────────
// (Kode keccak256 Anda disini - disingkat untuk keterbacaan, pastikan utuh)
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

// ... (Helpers hexToBytes, encodeUint256, encodeAddress, concat, buildDomainSeparator, buildOrderHash, signDigest, privateKeyToAddress sama seperti kode Anda)
// Disingkat untuk hemat ruang, pastikan Anda menyimpan fungsi-fungsi tersebut.

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
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'
const CHAIN_ID = 137n

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

function signDigest(privateKeyHex: string, digest: Uint8Array): string {
  const pkHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const sig = secp256k1.sign(digest, pkHex, { lowS: true })
  const r = sig.r.toString(16).padStart(64, '0')
  const s = sig.s.toString(16).padStart(64, '0')
  const v = sig.recovery === 0 ? '1b' : '1c'
  return `0x${r}${s}${v}`
}

function privateKeyToAddress(privateKeyHex: string): string {
  const pkHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const pubKey = secp256k1.getPublicKey(pkHex, false)
  const pubKeyBody = pubKey.slice(1)
  const hash = keccak256(pubKeyBody)
  return '0x' + Array.from(hash.slice(12)).map(b => b.toString(16).padStart(2,'0')).join('')
}

function buildOrderPayload(params: any): any {
  const { privateKey, funderAddress, tokenId, price, size, side, signatureType, negRisk } = params

  const SCALE       = 1_000_000n
  const priceBig    = BigInt(Math.round(price * 1_000_000))
  const sizeBig     = BigInt(Math.round(size  * 1_000_000))
  const makerAmount = side === 'BUY'  ? (priceBig * sizeBig) / SCALE : sizeBig
  const takerAmount = side === 'BUY'  ? sizeBig : (priceBig * sizeBig) / SCALE
  const salt        = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))

  const signerAddress = signatureType === 0 ? funderAddress : privateKeyToAddress(privateKey)

  const orderStruct = {
    salt, maker: funderAddress, signer: signerAddress,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: BigInt(tokenId), makerAmount, takerAmount,
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
      tokenID:      tokenId,
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

export async function POST(request: Request) {
  try {
    const body = await request.json() as any

    const {
      market_id, question, side, size, price,
      signal_confidence, ai_rationale, stop_loss_pct, take_profit_pct,
      credentials: clientCreds,
    } = body

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

    // Fetch market details
    const marketRes = await fetch(`${GAMMA_HOST}/markets/${market_id}`, { cache: 'no-store' })
    let market: any = {}
    if (marketRes.ok) {
      market = await marketRes.json()
    } else {
      // Fallback jika Gamma API down, kita asumsikan market ada
      console.warn(`Gamma API failed for ${market_id}, using fallback`)
    }

    // Determine Token ID
    const tokenIds = market.clobTokenIds ?? []
    let tokenId: string
    
    if (tokenIds.length >= 2) {
      tokenId = side === 'YES' ? tokenIds[0] : tokenIds[1]
    } else {
      // Fallback jika tidak ada tokenIds di Gamma, coba ambil dari market_id atau environment
      // Ini adalah risk, tapi mencegah crash
      return NextResponse.json({ error: 'Market token IDs not found in Gamma API.' }, { status: 400 })
    }

    const negRisk = Boolean(market.neg_risk)

    // Get minimum tick size (simplified)
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    
    const dec = Math.max(0, -Math.floor(Math.log10(tickSize)))
    let clampedPrice = Math.max(tickSize, Math.min(parseFloat(Number(price).toFixed(dec)), 1 - tickSize))
    
    // Price validation
    if (clampedPrice <= 0 || clampedPrice >= 1) {
      return NextResponse.json({ error: 'Price must be between 0 and 1' }, { status: 400 })
    }
    if (size <= 0) {
      return NextResponse.json({ error: 'Size must be greater than 0' }, { status: 400 })
    }

    const sigType = creds.signatureType ?? 1

    // Build Order
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
    // Logic: Jika Buy (YES), SL < Entry < TP
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
