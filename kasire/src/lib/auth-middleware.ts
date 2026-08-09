import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, type SessionPayload } from './crypto';

export type Role = 'super_admin' | 'admin_toko' | 'kasir';

export type AppEnv = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    JWT_SECRET: string;
    ALLOWED_ORIGIN: string;
    ENFORCE_GEO?: string;
    ASSETS: Fetcher;
  };
  Variables: {
    session: SessionPayload;
  };
};

export const SESSION_COOKIE = 'kasir_session';

/**
 * Wajib login. Membaca & memverifikasi cookie sesi, lalu menaruh payload
 * di c.get('session') untuk dipakai handler berikutnya.
 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ success: false, error: 'Sesi tidak ditemukan, silakan login kembali' }, 401);
  }

  const session = await verifyToken(token, c.env.JWT_SECRET);
  if (!session) {
    return c.json({ success: false, error: 'Sesi tidak valid atau sudah kedaluwarsa' }, 401);
  }

  c.set('session', session);
  await next();
}

/**
 * Wajib salah satu role tertentu. Pakai SETELAH requireAuth di chain middleware.
 * Contoh: app.post('/api/produk', requireAuth, requireRole('super_admin', 'admin_toko'), handler)
 */
export function requireRole(...roles: Role[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const session = c.get('session');
    if (!session || !roles.includes(session.role)) {
      return c.json({ success: false, error: 'Anda tidak memiliki akses untuk aksi ini' }, 403);
    }
    await next();
  };
}
