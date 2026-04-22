/**
 * Polymarket CLOB API Authentication Helper
 * Implements L2 HMAC‑SHA256 signing as per:
 * https://docs.polymarket.com/developers/CLOB/authentication
 */

export interface ClobCreds {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  funderAddress: string               // your proxy wallet address
  /** Private key hex for signing orders (0x…) – required when signature_type = 1 (POLY_PROXY) */
  privateKey?: string
  /** EOA address derived from privateKey – used as POLY_ADDRESS when signature_type = 1 */
  signerAddress?: string
  /** 0 = EOA, 1 = POLY_PROXY, 2 = GNOSIS_SAFE (default 0) */
  signatureType?: 0 | 1 | 2
}

/* -----------------------------------------------------------------
   1️⃣  Base64 / Base64‑url decoder (Polymarket secret)
------------------------------------------------------------------- */
function decodeBase64(str: string): Uint8Array {
  try {
    const base64 = str
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(str.length + (4 - (str.length % 4)) % 4, '=')

    const binary = atob(base64)
    return Uint8Array.from(binary, c => c.charCodeAt(0))
  } catch {
    // fallback – treat as plain UTF‑8
    return new TextEncoder().encode(str)
  }
}

/* -----------------------------------------------------------------
   2️⃣  HMAC‑SHA256 signature (exactly the Python client logic)
------------------------------------------------------------------- */
export async function buildClobSignature(
  secret: string,
  timestamp: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<string> {
  // Polymarket spec: timestamp + method + path + body (single quotes → double quotes)
  const bodyStr = body ? body.replace(/'/g, '"') : ''
  const message = `${timestamp}${method}${path}${bodyStr}`

  const secretBytes = decodeBase64(secret)

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))

  const sigBytes = new Uint8Array(sig)
  const base64 = btoa(String.fromCharCode(...sigBytes))
  // convert to base64url
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/* -----------------------------------------------------------------
   3️⃣  Derive signer address from a private key (only for POLY_PROXY)
------------------------------------------------------------------- */
export async function deriveSignerAddress(privateKeyHex: string): Promise<string> {
  if (!privateKeyHex) throw new Error('Private key is required')
  const cleanHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex

  if (!/^[0-9a-fA-F]{64}$/.test(cleanHex))
    throw new Error('Invalid private key format (must be 64 hex chars)')

  const { secp256k1 } = await import('@noble/curves/secp256k1')
  const { keccak_256 } = await import('@noble/hashes/sha3')

  const pubKey = secp256k1.getPublicKey(cleanHex, false) // 65‑bytes, uncompressed
  const pubKeyBody = pubKey.slice(1)                       // drop 0x04
  const hash = keccak_256(pubKeyBody)
  const addrBytes = hash.slice(-20)                       // last 20 bytes
  const addrHex = Array.from(addrBytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return '0x' + addrHex
}

/* -----------------------------------------------------------------
   4️⃣  Build the full set of authenticated CLOB headers
------------------------------------------------------------------- */
export async function buildClobHeaders(
  creds: ClobCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  const signature = await buildClobSignature(
    creds.apiSecret,
    timestamp,
    method,
    normalizedPath,
    body
  )

  // ---------- POLY_ADDRESS ----------
  // * EOA (type 0)               → funderAddress (proxy wallet itself)  
  // * POLY_PROXY (type 1)        → address derived from the private key (the EOA that signed)  
  // * GNOSIS_SAFE (type 2)      → funderAddress (proxy) – no special handling needed
  let polyAddress = creds.funderAddress

  if (creds.signatureType === 1) {
    // Proxy → need the signing EOA address
    if (creds.privateKey) {
      polyAddress = await deriveSignerAddress(creds.privateKey)
    } else if (creds.signerAddress) {
      polyAddress = creds.signerAddress
    } else {
      // Fallback – keep funderAddress but log a warning (order will be rejected)
      console.warn('[clob‑auth] signatureType = 1 but no privateKey/signerAddress supplied')
    }
  }

  return {
    POLY_ADDRESS:    polyAddress,
    POLY_SIGNATURE:  signature,
    POLY_TIMESTAMP:  timestamp,
    POLY_API_KEY:    creds.apiKey,
    POLY_PASSPHRASE: creds.apiPassphrase,
    'Content-Type':  'application/json',
  }
}

/* -----------------------------------------------------------------
   5️⃣  Resolve credentials (env‑vars have priority)
------------------------------------------------------------------- */
export function resolveCredentials(
  fromClient?: Partial<ClobCreds>
): ClobCreds | null {
  // ----- Environment variables (Vercel) -----
  const apiKey = process.env.POLYMARKET_API_KEY
  const apiSecret = process.env.POLYMARKET_API_SECRET
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  const sigEnv = process.env.POLYMARKET_SIGNATURE_TYPE

  if (apiKey && apiSecret && apiPassphrase && funderAddress) {
    return {
      apiKey,
      apiSecret,
      apiPassphrase,
      funderAddress,
      privateKey: privateKey ?? '',
      signatureType:
        sigEnv === '1' ? 1 : sigEnv === '2' ? 2 : 0, // default 0 (EOA)
    }
  }

  // ----- Client‑side credentials (Settings UI) -----
  if (
    fromClient?.apiKey &&
    fromClient?.apiSecret &&
    fromClient?.apiPassphrase &&
    fromClient?.funderAddress
  ) {
    const sig = fromClient.signatureType ?? 0
    if (![0, 1, 2].includes(sig)) {
      console.warn('[clob‑auth] Invalid signature type from client, falling back to 0')
    }
    return {
      apiKey:        fromClient.apiKey,
      apiSecret:     fromClient.apiSecret,
      apiPassphrase: fromClient.apiPassphrase,
      funderAddress: fromClient.funderAddress,
      privateKey:    fromClient.privateKey,
      signatureType: [0, 1, 2].includes(sig) ? sig : 0,
    }
  }

  return null
}
