/**
 * Polymarket CLOB API Authentication Helper
 * Implements L2 HMAC-SHA256 signing as per:
 * https://docs.polymarket.com/developers/CLOB/authentication
 *
 * Every authenticated request needs these headers:
 *   POLY_ADDRESS      → your signer wallet address (EOA)
 *   POLY_SIGNATURE    → HMAC-SHA256(timestamp + method + path + body, base64Secret)
 *   POLY_TIMESTAMP    → unix seconds
 *   POLY_API_KEY      → your api key (UUID)
 *   POLY_PASSPHRASE   → your api passphrase
 *
 * signatureType:
 *   0 = EOA           (MetaMask / hardware wallet — direct EOA key)
 *   1 = POLY_PROXY    (Email / Magic Link / Google login — proxy contract)
 *   2 = GNOSIS_SAFE   (multisig)
 */

export interface ClobCreds {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  funderAddress: string
  /** Private key hex for signing orders (0x...) */
  privateKey?: string
  /** EOA address derived from privateKey — used as POLY_ADDRESS in L2 headers */
  signerAddress?: string
  /** 0 = EOA (MetaMask), 1 = POLY_PROXY (Email/Magic), 2 = GNOSIS_SAFE (Multisig). Default: 0 */
  signatureType?: 0 | 1 | 2
}

/**
 * Decode a base64url OR standard base64 string to Uint8Array.
 * Polymarket API secrets use base64url encoding (uses - and _ instead of + and /).
 */
function decodeBase64(str: string): Uint8Array {
  // Convert base64url to standard base64
  const base64 = str
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(str.length + (4 - (str.length % 4)) % 4, '=')
  try {
    const binary = atob(base64)
    return Uint8Array.from(binary, c => c.charCodeAt(0))
  } catch {
    // Not valid base64 at all — use raw UTF-8
    return new TextEncoder().encode(str)
  }
}

/**
 * Derive the Ethereum EOA checksum address from a hex private key.
 * Uses @noble/curves (secp256k1) + keccak256 via Web Crypto.
 * Returns lowercase 0x-prefixed address (20 bytes).
 */
export async function deriveSignerAddress(privateKeyHex: string): Promise<string> {
  // Perbaikan: Validasi format private key dan hex characters
  if (!privateKeyHex) {
    throw new Error('Private key is required')
  }

  const cleanHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  
  if (cleanHex.length < 64) {
    throw new Error('Invalid private key format: too short')
  }
  
  // Validasi hex characters (0-9, a-f, A-F)
  if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
    throw new Error('Private key must be 64 hex characters')
  }

  try {
    const { secp256k1 } = await import('@noble/curves/secp256k1')
    const pubKey = secp256k1.getPublicKey(cleanHex, false) // uncompressed, 65 bytes
    // keccak256 of the 64-byte pubkey body (skip first byte 0x04)
    const pubKeyBytes = pubKey.slice(1)
    const { keccak_256 } = await import('@noble/hashes/sha3')
    const hash = keccak_256(pubKeyBytes)
    // Take last 20 bytes → Ethereum address
    const addrBytes = hash.slice(-20)
    const addrHex = Array.from(addrBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    return '0x' + addrHex
  } catch {
    // Fallback: if noble not available, return empty string to indicate derivation failed
    return ''
  }
}

export async function buildClobSignature(
  secret: string,
  timestamp: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<string> {
  // Exact logic from py-clob-client/signing/hmac.py:
  // message = timestamp + method + requestPath (+ body if present)
  // body: replace single quotes with double quotes (same as py client)
  const bodyStr = body ? body.replace(/'/g, '"') : ''
  const message = `${timestamp}${method}${path}${bodyStr}`

  // Secret is base64url-encoded → decode to raw bytes (urlsafe_b64decode)
  const secretBytes = decodeBase64(secret)

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))

  // Output must be base64url-encoded (urlsafe_b64encode) — same as py client
  const sigBytes = new Uint8Array(sig)
  const base64 = btoa(String.fromCharCode(...sigBytes))
  // Convert standard base64 to base64url
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Build a full set of authenticated CLOB headers for a request.
 */
export async function buildClobHeaders(
  creds: ClobCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString()

  // Polymarket CLOB signing rule:
  // The full path INCLUDING query string is used in the HMAC message.
  // e.g. sign "/balance-allowance?asset_type=0" as-is
  const signature = await buildClobSignature(creds.apiSecret, timestamp, method, path, body)

  // L2 headers — exact match to py-clob-client create_level_2_headers():
  // POLY_ADDRESS = signer.address() = EOA address derived from private key
  // NOT the funder/proxy address — those are different for POLY_PROXY accounts
  const signerAddress = creds.signerAddress ||
    (creds.privateKey ? await deriveSignerAddress(creds.privateKey) : creds.funderAddress)

  return {
    'POLY_ADDRESS':    signerAddress,
    'POLY_SIGNATURE':  signature,
    'POLY_TIMESTAMP':  timestamp,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.apiPassphrase,
    'Content-Type':    'application/json',
  }
}

/**
 * Resolve credentials with priority:
 *   1. Server env vars  (set in Vercel dashboard → preferred for production)
 *   2. Client-passed creds (from Settings UI stored in localStorage)
 *
 * signatureType env var: POLYMARKET_SIGNATURE_TYPE (0 or 1, default 0)
 */
export function resolveCredentials(fromClient?: Partial<ClobCreds>): ClobCreds | null {
  // Support both naming conventions — user sets whichever they configured in Vercel
  const apiKey = (
    process.env.CLOB_API_KEY ??
    process.env.POLYMARKET_API_KEY
  )
  const apiSecret = (
    process.env.CLOB_API_SECRET ??
    process.env.POLYMARKET_API_SECRET
  )
  const apiPassphrase = (
    process.env.CLOB_API_PASSPHRASE ??
    process.env.POLYMARKET_API_PASSPHRASE
  )
  const funderAddress = (
    process.env.FUNDER_ADDRESS ??
    process.env.POLYMARKET_FUNDER_ADDRESS
  )
  const privateKey = (
    process.env.WALLET_PRIVATE_KEY ??
    process.env.POLYMARKET_PRIVATE_KEY
  )
  const sigTypeEnv = process.env.POLYMARKET_SIGNATURE_TYPE

  // Perbaikan: Default signature type ke 0 (EOA) jika tidak di-set
  if (apiKey && apiSecret && apiPassphrase && funderAddress) {
    return {
      apiKey,
      apiSecret,
      apiPassphrase,
      funderAddress,
      privateKey: privateKey ?? '',
      signatureType: sigTypeEnv === '1' ? 1 : 0, // Default ke EOA
    }
  }

  if (
    fromClient?.apiKey &&
    fromClient?.apiSecret &&
    fromClient?.apiPassphrase &&
    fromClient?.funderAddress
  ) {
    // Perbaikan: Validasi signature type dari client
    const sigType = fromClient.signatureType ?? 0
    if (![0, 1, 2].includes(sigType)) {
      throw new Error('Invalid signature type. Must be 0, 1, or 2')
    }

    return {
      apiKey:         fromClient.apiKey,
      apiSecret:      fromClient.apiSecret,
      apiPassphrase:  fromClient.apiPassphrase,
      funderAddress:  fromClient.funderAddress,
      signatureType:  sigType,
    }
  }

  return null
}
