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
  try {
    // Convert base64url to standard base64
    const base64 = str
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(str.length + (4 - (str.length % 4)) % 4, '=')
    
    const binary = atob(base64)
    return Uint8Array.from(binary, c => c.charCodeAt(0))
  } catch (e) {
    // If decoding fails, try to encode the string directly as UTF-8
    // (Fallback for non-base64 secrets, though Polymarket expects base64)
    return new TextEncoder().encode(str)
  }
}

/**
 * Derive the Ethereum EOA checksum address from a hex private key.
 * Uses @noble/curves (secp256k1) + keccak256.
 */
export async function deriveSignerAddress(privateKeyHex: string): Promise<string> {
  if (!privateKeyHex) throw new Error('Private key is required')

  const cleanHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  if (cleanHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
    throw new Error('Invalid private key format. Must be 64 hex chars.')
  }

  try {
    // Dynamic import to ensure module is available in server context
    const { secp256k1 } = await import('@noble/curves/secp256k1')
    const { keccak_256 } = await import('@noble/hashes/sha3')

    // Get public key (uncompressed 65 bytes)
    const pubKey = secp256k1.getPublicKey(cleanHex, false)
    // Skip the first byte (0x04) to get 64 bytes
    const pubKeyBytes = pubKey.slice(1)
    
    // Hash with Keccak256
    const hash = keccak_256(pubKeyBytes)
    
    // Take last 20 bytes for Ethereum address
    const addrBytes = hash.slice(-20)
    const addrHex = Array.from(addrBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    return '0x' + addrHex
  } catch (error) {
    console.error('Error deriving signer address:', error)
    throw new Error('Failed to derive signer address from private key')
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

  // Secret is base64url-encoded → decode to raw bytes
  const secretBytes = decodeBase64(secret)

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))

    // Output must be base64url-encoded (urlsafe_b64encode)
    const sigBytes = new Uint8Array(sig)
    const base64 = btoa(String.fromCharCode(...sigBytes))
    // Convert standard base64 to base64url
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch (error) {
    console.error('Error building HMAC signature:', error)
    throw new Error('Failed to generate HMAC signature')
  }
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
  
  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  const signature = await buildClobSignature(creds.apiSecret, timestamp, method, normalizedPath, body)

  // Determine signer address
  // For EOA (type 0), POLY_ADDRESS is the EOA derived from private key OR funderAddress
  // For Proxy (type 1), POLY_ADDRESS is usually the EOA derived from private key
  let signerAddress = creds.signerAddress
  
  if (!signerAddress && creds.privateKey) {
    signerAddress = await deriveSignerAddress(creds.privateKey)
  }
  
  if (!signerAddress) {
    signerAddress = creds.funderAddress
  }

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
 */
export function resolveCredentials(fromClient?: Partial<ClobCreds>): ClobCreds | null {
  // Prioritas 1: Environment Variables (Vercel)
  const envApiKey = process.env.CLOB_API_KEY ?? process.env.POLYMARKET_API_KEY
  const envApiSecret = process.env.CLOB_API_SECRET ?? process.env.POLYMARKET_API_SECRET
  const envApiPassphrase = process.env.CLOB_API_PASSPHRASE ?? process.env.POLYMARKET_API_PASSPHRASE
  const envFunderAddress = process.env.FUNDER_ADDRESS ?? process.env.POLYMARKET_FUNDER_ADDRESS
  const envPrivateKey = process.env.WALLET_PRIVATE_KEY ?? process.env.POLYMARKET_PRIVATE_KEY
  const envSigType = process.env.POLYMARKET_SIGNATURE_TYPE

  if (envApiKey && envApiSecret && envApiPassphrase && envFunderAddress) {
    return {
      apiKey: envApiKey,
      apiSecret: envApiSecret,
      apiPassphrase: envApiPassphrase,
      funderAddress: envFunderAddress,
      privateKey: envPrivateKey,
      // Default signature type to 0 (EOA) if not set or invalid
      signatureType: (envSigType === '1' || envSigType === '2') ? Number(envSigType) as 1 | 2 : 0,
    }
  }

  // Prioritas 2: Credentials dari Client (localStorage / Settings UI)
  if (
    fromClient?.apiKey &&
    fromClient?.apiSecret &&
    fromClient?.apiPassphrase &&
    fromClient?.funderAddress
  ) {
    const sigType = fromClient.signatureType ?? 0
    if
 (![0, 1, 2].includes(sigType)
) {
      console.warn('Invalid signature type from client, defaulting to 0')
    }

    return {
      apiKey: fromClient.apiKey,
      apiSecret: fromClient.apiSecret,
      apiPassphrase: fromClient.apiPassphrase,
      funderAddress: fromClient.funderAddress,
      privateKey: fromClient.privateKey,
      signatureType: [0, 1, 2].includes(sigType) ? sigType : 0,
    }
  }

  return null
}
