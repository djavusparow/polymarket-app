/**
 * Polymarket CLOB API Authentication Helper
 * Implements L2 HMAC-SHA256 signing as per:
 * https://docs.polymarket.com/developers/CLOB/authentication
 *
 * Every authenticated request needs these headers:
 *   POLY_ADDRESS      → your funder/proxy wallet address
 *   POLY_SIGNATURE    → HMAC-SHA256(timestamp + method + path + body, base64Secret)
 *   POLY_TIMESTAMP    → unix seconds
 *   POLY_NONCE        → always "0"
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
  /** 0 = EOA (MetaMask), 1 = POLY_PROXY (Email/Magic). Default: 1 */
  signatureType?: 0 | 1 | 2
}

/**
 * Build HMAC-SHA256 signature for Polymarket CLOB API.
 * Message = timestamp + METHOD + requestPath + body
 * Secret must be base64-encoded (as returned by create_or_derive_api_creds).
 */
export async function buildClobSignature(
  secret: string,
  timestamp: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<string> {
  const message = `${timestamp}${method}${path}${body}`

  // Polymarket API secret may be base64-encoded OR raw string depending on account type.
  // Try base64 decode first; if it fails or looks like plain text, use raw UTF-8 bytes.
  let secretBytes: Uint8Array
  try {
    const decoded = atob(secret)
    // Sanity check: valid base64 decode typically produces non-printable bytes
    // If all chars are printable ASCII it might just be a plain string — use raw
    const nonPrintable = decoded.split('').some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)
    if (nonPrintable || decoded.length !== secret.length * 0.75) {
      secretBytes = Uint8Array.from(decoded, c => c.charCodeAt(0))
    } else {
      // Looks like the decoded result is still plain text → use raw UTF-8
      secretBytes = new TextEncoder().encode(secret)
    }
  } catch {
    // atob failed → secret is not base64, use raw UTF-8
    secretBytes = new TextEncoder().encode(secret)
  }

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))

  // Return base64-encoded signature
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
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
  const signature = await buildClobSignature(creds.apiSecret, timestamp, method, path, body)

  return {
    'POLY_ADDRESS':     creds.funderAddress,
    'POLY_SIGNATURE':   signature,
    'POLY_TIMESTAMP':   timestamp,
    'POLY_NONCE':       '0',
    'POLY_API_KEY':     creds.apiKey,
    'POLY_PASSPHRASE':  creds.apiPassphrase,
    'Content-Type':     'application/json',
  }
}

/**
 * Resolve credentials with priority:
 *   1. Server env vars  (set in Vercel dashboard → preferred for production)
 *   2. Client-passed creds (from Settings UI stored in localStorage)
 *
 * signatureType env var: POLYMARKET_SIGNATURE_TYPE (0 or 1, default 1)
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

  if (apiKey && apiSecret && apiPassphrase && funderAddress) {
    return {
      apiKey,
      apiSecret,
      apiPassphrase,
      funderAddress,
      privateKey: privateKey ?? '',
      signatureType: sigTypeEnv === '0' ? 0 : 1,
    }
  }

  if (
    fromClient?.apiKey &&
    fromClient?.apiSecret &&
    fromClient?.apiPassphrase &&
    fromClient?.funderAddress
  ) {
    return {
      apiKey:         fromClient.apiKey,
      apiSecret:      fromClient.apiSecret,
      apiPassphrase:  fromClient.apiPassphrase,
      funderAddress:  fromClient.funderAddress,
      signatureType:  fromClient.signatureType ?? 1,
    }
  }

  return null
}
