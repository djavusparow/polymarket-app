// lib/clob-auth.ts
// FIX: Gunakan @noble/hashes untuk keccak256 yang benar (bukan implementasi manual).
// FIX: Header CLOB L2 auth menggunakan HMAC-SHA256, bukan EIP-712 (EIP-712 hanya untuk signing order struct).

import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'

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
// Keccak-256 (benar, via @noble/hashes)
// ==============================================
function keccak256(input: Uint8Array): Uint8Array {
  return keccak_256(input)
}

function keccak256Str(s: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(s))
}

// ==============================================
// Hex / Encoding Helpers
// ==============================================
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length % 2 !== 0) throw new Error('Invalid hex string length')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
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

// ==============================================
// CLOB L2 Auth Headers (HMAC-SHA256)
// FIX: Polymarket CLOB L2 auth menggunakan HMAC-SHA256 dengan apiSecret,
//      BUKAN EIP-712. EIP-712 hanya untuk signing order struct.
// Referensi: https://docs.polymarket.com/#authentication-l2
// ==============================================
export async function buildClobHeaders(
  creds: ClobCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  // HMAC-SHA256: message = timestamp + method.toUpperCase() + path + body
  const message = `${timestamp}${method.toUpperCase()}${normalizedPath}${body}`
  const secretBytes = new TextEncoder().encode(creds.apiSecret)
  const messageBytes = new TextEncoder().encode(message)

  const sigBytes = hmac(sha256, secretBytes, messageBytes)
  const signature = Buffer.from(sigBytes).toString('base64')

  const headers: Record<string, string> = {
    'POLY_ADDRESS':    creds.funderAddress,
    'POLY_SIGNATURE':  signature,
    'POLY_TIMESTAMP':  timestamp,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.apiPassphrase,
    'Content-Type':    'application/json',
  }

  // Builder Attribution Headers
  if (creds.builderCode) {
    headers['POLY_BUILDER_CODE'] = creds.builderCode
  }
  if (creds.builderApiKey) {
    headers['POLY_BUILDER_API_KEY']    = creds.builderApiKey
    headers['POLY_BUILDER_API_SECRET'] = creds.builderApiSecret
    headers['POLY_BUILDER_PASSPHRASE'] = creds.builderPassphrase
  }

  return headers
}

// ==============================================
// Salt Generator
// ==============================================
export function generateSalt(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1_000_000))
}

// ==============================================
// EIP-712 Order Signing
// Ini digunakan untuk menandatangani ORDER STRUCT (bukan header API).
// ==============================================
const ORDER_EIP712_TYPE =
  'Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)'

export function buildDomainSeparator(contractAddress: string, chainId = 137n): Uint8Array {
  const domainTypeHash = keccak256Str(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  )
  const nameHash    = keccak256Str('Polymarket CTF Exchange')
  const versionHash = keccak256Str('1')
  return keccak256(concat(
    domainTypeHash,
    nameHash,
    versionHash,
    encodeUint256(chainId),
    encodeAddress(contractAddress),
  ))
}

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
  side: number        // 0 = BUY, 1 = SELL
  signatureType: number
}): Uint8Array {
  const typeHash = keccak256Str(ORDER_EIP712_TYPE)
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

export function signOrderDigest(privateKeyHex: string, digest: Uint8Array): string {
  const pkHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const sig = secp256k1.sign(digest, pkHex, { lowS: true })
  const r = sig.r.toString(16).padStart(64, '0')
  const s = sig.s.toString(16).padStart(64, '0')
  const v = sig.recovery === 0 ? '1b' : '1c'
  return `0x${r}${s}${v}`
}
