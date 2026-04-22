// lib/clob-auth.ts

export interface ClobCreds {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  funderAddress: string
  privateKey?: string
  signerAddress?: string
  signatureType?: 0 | 1 | 2
}

function decodeBase64(str: string): Uint8Array {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(str.length + (4 - (str.length % 4)) % 4, '=')
    const binary = atob(base64)
    return Uint8Array.from(binary, c => c.charCodeAt(0))
  } catch {
    return new TextEncoder().encode(str)
  }
}

export async function buildClobSignature(
  secret: string,
  timestamp: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<string> {
  const bodyStr = body ? body.replace(/'/g, '"') : ''
  const message = `${timestamp}${method}${path}${bodyStr}`
  
  const secretBytes = decodeBase64(secret)
  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  const sigBytes = new Uint8Array(sig)
  const base64 = btoa(String.fromCharCode(...sigBytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function buildClobHeaders(
  creds: ClobCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = ''
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  
  // Normalisasi path (pastikan dimulai dengan /)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  const signature = await buildClobSignature(creds.apiSecret, timestamp, method, normalizedPath, body)

  // POLY_ADDRESS harus diisi dengan Proxy Wallet Address (funderAddress)
  // Karena kita menggunakan API Key pribadi, Polymarket akan mengenali akun ini.
  const polyAddress = creds.funderAddress

  return {
    'POLY_ADDRESS':    polyAddress,
    'POLY_SIGNATURE':  signature,
    'POLY_TIMESTAMP':  timestamp,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.apiPassphrase,
    'Content-Type':    'application/json',
  }
}

export function resolveCredentials(fromClient?: Partial<ClobCreds>): ClobCreds | null {
  const apiKey = process.env.POLYMARKET_API_KEY
  const apiSecret = process.env.POLYMARKET_API_SECRET
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  const sigType = process.env.POLYMARKET_SIGNATURE_TYPE

  // Gunakan env vars jika ada
  if (apiKey && apiSecret && apiPassphrase && funderAddress) {
    return {
      apiKey,
      apiSecret,
      apiPassphrase,
      funderAddress,
      privateKey: privateKey ?? '',
      signatureType: sigType === '1' ? 1 : (sigType === '2' ? 2 : 0),
    }
  }

  // Fallback ke client creds
  if (fromClient?.apiKey && fromClient?.apiSecret && fromClient?.apiPassphrase && fromClient?.funderAddress) {
    return {
      apiKey: fromClient.apiKey,
      apiSecret: fromClient.apiSecret,
      apiPassphrase: fromClient.apiPassphrase,
      funderAddress: fromClient.funderAddress,
      privateKey: fromClient.privateKey,
      signatureType: fromClient.signatureType ?? 0,
    }
  }

  return null
}
