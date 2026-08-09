// ==========================================================
// crypto.ts — Helper kriptografi murni Web Crypto API
// Dipakai oleh Worker (tidak butuh library eksternal)
// ==========================================================

const PBKDF2_ITERATIONS = 100_000;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Bandingkan dua string hex secara timing-safe (mencegah timing attack). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Hash password baru untuk disimpan ke DB (dipakai saat membuat/reset user).
 * Mengembalikan { hash, salt } — keduanya disimpan sebagai kolom terpisah.
 */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePBKDF2(password, salt);
  return { hash, salt: toBase64(salt) };
}

/** Verifikasi password saat login, membandingkan dengan hash+salt yang tersimpan. */
export async function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  if (!storedHash || !storedSalt) return false;
  const salt = fromBase64(storedSalt);
  const computedHash = await derivePBKDF2(password, salt);
  return timingSafeEqual(computedHash, storedHash);
}

async function derivePBKDF2(password: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(derivedBits);
}

// ==========================================================
// Session token: HMAC-SHA256 signed, mirip JWT (header.payload.sig)
// ==========================================================

export interface SessionPayload {
  uid: number;
  role: 'super_admin' | 'admin_toko' | 'kasir';
  toko_pusat_id: number; // batas TENANT -- WAJIB ada di semua role, termasuk super_admin
  toko_id: number | null;
  exp: number; // unix seconds
}

function base64url(input: string): string {
  return btoa(input).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return atob(padded);
}

export async function signToken(payload: SessionPayload, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  const sigB64 = base64url(String.fromCharCode(...new Uint8Array(signature)));
  return `${header}.${body}.${sigB64}`;
}

/**
 * Verifikasi signature + expiry token. Mengembalikan payload jika valid, null jika tidak
 * (signature invalid, format rusak, atau sudah expired).
 */
export async function verifyToken(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = fromBase64(sig.replace(/-/g, '+').replace(/_/g, '/'));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(`${header}.${body}`));
    if (!valid) return null;

    const payload: SessionPayload = JSON.parse(base64urlDecode(body));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
