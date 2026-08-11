import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken } from './crypto';
import type { AppEnv, Role } from './types';
import { SESSION_COOKIE } from './types';

export type { AppEnv, Role };
export { SESSION_COOKIE };

/**
 * Wajib login. Baca & verifikasi cookie sesi, taruh payload di c.get('session').
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
 * Wajib salah satu role. Selalu dipakai setelah requireAuth.
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
