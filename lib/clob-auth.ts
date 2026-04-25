// lib/clob-auth.ts

import { secp256k1 } from '@noble/curves/secp256k1'

// ==============================================
// Environment Variables
// ==============================================
const POLY_API_KEY       = process.env.POLY_API_KEY ?? ''
const POLY_SECRET        = process.env.POLY_SECRET ?? ''
const POLY_PASSPHRASE    = process.env.POLY_PASSPHRASE ?? ''
const FUNDER_ADDRESS     = process.env.FUNDER_ADDRESS ?? ''
const SIGNATURE_TYPE     = parseInt(process.env.SIGNATURE_TYPE ?? '0', 10)
const POLY_PRIVATE_KEY   = process.env.POLY_PRIVATE_KEY ?? ''

// Builder Attribution
const POLY_BUILDER_CODE       = process.env.POLY_BUILDER_CODE ?? ''
const POLY_BUILDER_API_KEY    = process.env.POLY_BUILDER_API_KEY ?? ''
const POLY_BUILDER_SECRET     = process.env.POLY_BUILDER_SECRET ?? ''
const POLY_BUILDER_PASSPHRASE = process.env.POLY_BUILDER_PASSPHRASE ?? ''

// ==============================================
// Credentials Resolver
// ==============================================
export interface ClobCreds {
  apiKey:        string
  apiSecret:     string
  apiPassphrase: string
  funderAddress: string
  signatureType: number
  privateKey:    string
  // Builder attribution
  builderCode:       string
  builderApiKey:     string
  builderApiSecret:  string
  builderPassphrase: string
}

export function resolveCredentials(clientCreds?: any): ClobCreds | null {
  // Priority 1: Env vars (server-side, lebih aman)
  if (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE && FUNDER_ADDRESS && POLY_PRIVATE_KEY) {
    return {
      apiKey:        POLY_API_KEY,
      apiSecret:     POLY_SECRET,
      apiPassphrase: POLY_PASSPHRASE,
      funderAddress: FUNDER_ADDRESS,
      signatureType: SIGNATURE_TYPE,
      privateKey:    POLY_PRIVATE_KEY,
      builderCode:       POLY_BUILDER_CODE,
      builderApiKey:     POLY_BUILDER_API_KEY,
      builderApiSecret:  POLY_BUILDER_SECRET,
      builderPassphrase: POLY_BUILDER_PASSPHRASE,
    }
  }

  // Priority 2: Client-side credentials (jika ada)
  if (clientCreds?.apiKey && clientCreds?.apiSecret && clientCreds?.funderAddress) {
    return {
      apiKey:        clientCreds.apiKey,
      apiSecret:     clientCreds.apiSecret,
      apiPassphrase: clientCreds.apiPassphrase ?? '',
      funderAddress: clientCreds.funderAddress,
      signatureType: clientCreds.signatureType ?? SIGNATURE_TYPE,
      privateKey:    clientCreds.privateKey ?? '',
      builderCode:       clientCreds.builderCode ?? POLY_BUILDER_CODE,
      builderApiKey:     clientCreds.builderApiKey ?? POLY_BUILDER_API_KEY,
      builderApiSecret:  clientCreds.builderApiSecret ?? POLY_BUILDER_SECRET,
      builderPassphrase: clientCreds.builderPassphrase ?? POLY_BUILDER_PASSPHRASE,
    }
  }

  return null
}

// ==============================================
// Signature Generation (EIP-712)
// ==============================================
const ORDER_EIP712_TYPE = 'Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)'
const DOMAIN_EIP712_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'

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
      for ( let y = 0; y < 50; y += 10) {
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

function keccak256String(s: string): Uint8Array {
  return keccak256(new TextEncoder().encode(s))
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

function hashString(s: string): Uint8Array {
  return keccak256String(s)
}

function hashBytes(b: Uint8Array): Uint8Array {
  return keccak256(b)
}

export async function buildClobHeaders(
  creds: ClobCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  
  // Build EIP-712 digest for signature
  const domainHash = hashString('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
  const nameHash = hashString('Polymarket CTF Exchange')
  const versionHash = hashString('1')
  const chainId = 137n // Polygon Mainnet
  const verifyingContract = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' // CTF Exchange

  const domainSeparator = keccak256(concat(
    domainHash,
    nameHash,
    versionHash,
    encodeUint256(chainId),
    encodeAddress(verifyingContract)
  ))

  // If body exists, hash it; otherwise use empty bytes
  const bodyBytes = body ? new TextEncoder().encode(body) : new Uint8Array(0)
  const bodyHash = hashBytes(bodyBytes)

  // Build the signing digest
  // Encode: method + path + timestamp + body hash
  const msgBytes = new TextEncoder().encode(`${method.toUpperCase()}${normalizedPath}${timestamp}`)
  const msgHash = hashBytes(msgBytes)
  
  // Final digest: keccak256(0x19 + 0x01 + domainSeparator + msgHash + bodyHash)
  const signableBytes = concat(
    new Uint8Array([0x19, 0x01]), // Standard EIP-191 prefix
    domainSeparator,
    msgHash,
    bodyHash
  )
  const signableHash = keccak256(signableBytes)

  // Sign with private key using noble/secp256k1
  const pkHex = creds.privateKey.startsWith('0x') ? creds.privateKey.slice(2) : creds.privateKey
  const signature = secp256k1.sign(signableHash, pkHex, { lowS: true })
  
  const r = signature.r.toString(16).padStart(64, '0')
  const s = signature.s.toString(16).padStart(64, '0')
  const v = signature.recovery === 0 ? '1b' : '1c'
  const sigHex = `0x${r}${s}${v}`

  const headers: Record<string, string> = {
    'POLY_ADDRESS':    creds.funderAddress,
    'POLY_SIGNATURE':  sigHex,
    'POLY_TIMESTAMP':  timestamp,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.apiPassphrase,
    'Content-Type':    'application/json',
  }

  // Tambahkan Builder Attribution Headers jika ada
  if (creds.builderCode) {
    headers['POLY_BUILDER_CODE'] = creds.builderCode
  }
  if (creds.builderApiKey) {
    headers['POLY_BUILDER_API_KEY'] = creds.builderApiKey
    headers['POLY_BUILDER_API_SECRET'] = creds.builderApiSecret
    headers['POLY_BUILDER_PASSPHRASE'] = creds.builderPassphrase
  }

  return headers
}

// Helper: Generate random salt
export function generateSalt(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000000))
}

// Helper: Encode order struct for signature
export function encodeOrderForSignature(order: {
  salt: bigint
  maker: string
  signer: string
  taker: string
  tokenId: bigint
  makerAmount: bigint
  takerAmount: bigint
  expiration: bigint
  nonce: bigint
  feeRateBps: bigint
  side: number  // 0 = BUY, 1 = SELL
  signatureType: number
}): Uint8Array {
  const typeHash = keccak256String(ORDER_EIP712_TYPE)
  
  return keccak256(concat(
    typeHash,
    encodeUint256(order.salt),
    encodeAddress(order.maker),
    encodeAddress(order.signer),
    encodeAddress(order.taker),
    encodeUint256(order.tokenId),
    encodeUint256(order.makerAmount),
    encodeUint256(order.takerAmount),
    encodeUint256(order.expiration),
    encodeUint256(order.nonce),
    encodeUint256(order.feeRateBps),
    encodeUint256(BigInt(order.side)),
    encodeUint256(BigInt(order.signatureType)),
  ))
}
