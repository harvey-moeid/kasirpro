import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../lib/crypto';
import { requireAuth } from '../lib/auth-middleware';
import type { AppEnv } from '../lib/types';
import {
  SESSION_COOKIE,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_LOCK_MINUTES,
  DAFTAR_TAB_ADMIN,
} from '../lib/types';
import { validasiTokoIdMilikTenant } from '../lib/helpers';

const auth = new Hono<AppEnv>();

// ==========================================================
// LOGIN
// ==========================================================

auth.post('/login', async (c) => {
  try {
    const { username, password } = await c.req.json<{ username?: string; password?: string }>();
    if (!username || !password) {
      return c.json({ success: false, error: 'Username dan password wajib diisi' }, 400);
    }

    const db = c.env.DB;
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<any>();

    // Cek rate limit sebelum verifikasi password
    if (user?.locked_until) {
      const lockExpiry = new Date(user.locked_until).getTime();
      if (Date.now() < lockExpiry) {
        const sisaMenit = Math.ceil((lockExpiry - Date.now()) / 60000);
        return c.json(
          { success: false, error: `Akun terkunci sementara. Coba lagi dalam ${sisaMenit} menit.` },
          429
        );
      }
    }

    // Selalu jalankan verifyPassword (timing-safe — cegah username enumeration)
    const isValid = user
      ? await verifyPassword(password, user.password_hash, user.password_salt)
      : await verifyPassword(password, '', 'AAAAAAAAAAAAAAAAAAAAAA==');

    if (!user || !isValid || user.is_active !== 1) {
      if (user) {
        const attempts = (user.failed_attempts ?? 0) + 1;
        const shouldLock = attempts >= LOGIN_MAX_ATTEMPTS;
        const lockedUntil = shouldLock
          ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000).toISOString()
          : null;
        await db
          .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
          .bind(attempts, lockedUntil ?? user.locked_until ?? null, user.id)
          .run();
        if (shouldLock) {
          return c.json(
            { success: false, error: `Terlalu banyak percobaan login gagal. Akun dikunci selama ${LOGIN_LOCK_MINUTES} menit.` },
            429
          );
        }
      }
      return c.json({ success: false, error: 'Username atau password salah' }, 401);
    }

    // Login sukses — reset counter
    await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(user.id).run();

    const exp = Math.floor(Date.now() / 1000) + 8 * 60 * 60; // 8 jam
    const token = await signToken(
      { uid: user.id, role: user.role, toko_pusat_id: user.toko_pusat_id, toko_id: user.toko_id ?? null, exp },
      c.env.JWT_SECRET
    );

    const cookiePath = c.req.header('X-Kasir-Base') ?? '/';
    setCookie(c, SESSION_COOKIE, token, {
      path: cookiePath,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: 8 * 60 * 60,
    });

    return c.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        nama: user.nama_lengkap,
        role: user.role,
        toko_pusat_id: user.toko_pusat_id,
        toko_id: user.toko_id,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Kesalahan server internal' }, 500);
  }
});

// ==========================================================
// LOGOUT
// ==========================================================

auth.post('/logout', async (c) => {
  const cookiePath = c.req.header('X-Kasir-Base') ?? '/';
  deleteCookie(c, SESSION_COOKIE, { path: cookiePath });
  return c.json({ success: true });
});

// ==========================================================
// ME — profil user yang sedang login
// ==========================================================

auth.get('/me', requireAuth, async (c) => {
  const session = c.get('session');
  const user = await c.env.DB
    .prepare('SELECT id, username, nama_lengkap, role, toko_pusat_id, toko_id, hidden_tabs FROM users WHERE id = ? AND is_active = 1')
    .bind(session.uid)
    .first<any>();
  if (!user) return c.json({ success: false, error: 'User tidak ditemukan' }, 404);
  user.hidden_tabs = user.hidden_tabs ? JSON.parse(user.hidden_tabs) : [];
  return c.json({ success: true, user });
});

// ==========================================================
// TABS PERSONAL — preferensi tampilan tab milik akun sendiri
// ==========================================================

auth.put('/me/tabs', requireAuth, async (c) => {
  try {
    const session = c.get('session');
    const body = await c.req.json<{ hidden_tabs?: string[] }>();
    const hidden = Array.isArray(body.hidden_tabs)
      ? body.hidden_tabs.filter((t) => (DAFTAR_TAB_ADMIN as readonly string[]).includes(t))
      : [];
    await c.env.DB.prepare('UPDATE users SET hidden_tabs = ? WHERE id = ?')
      .bind(JSON.stringify(hidden), session.uid)
      .run();
    return c.json({ success: true, hidden_tabs: hidden });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan preferensi tampilan' }, 400);
  }
});

// ==========================================================
// GANTI PASSWORD SENDIRI (butuh password lama)
// ==========================================================

auth.post('/change-password', requireAuth, async (c) => {
  try {
    const session = c.get('session');
    const { password_lama, password_baru } = await c.req.json<{ password_lama?: string; password_baru?: string }>();

    if (!password_lama || !password_baru) {
      return c.json({ success: false, error: 'Password lama dan password baru wajib diisi' }, 400);
    }
    if (String(password_baru).length < 6) {
      return c.json({ success: false, error: 'Password baru minimal 6 karakter' }, 400);
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').bind(session.uid).first<any>();
    if (!user) return c.json({ success: false, error: 'User tidak ditemukan' }, 404);

    const valid = await verifyPassword(password_lama, user.password_hash, user.password_salt);
    if (!valid) return c.json({ success: false, error: 'Password lama salah' }, 401);

    const { hash, salt } = await hashPassword(password_baru);
    await c.env.DB
      .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .bind(hash, salt, session.uid)
      .run();

    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal mengubah password' }, 500);
  }
});

// ==========================================================
// TABS CABANG — kebijakan tab aktif per cabang (super_admin only set)
// ==========================================================

auth.get('/tabs-cabang', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const tokoId =
    session.role === 'super_admin'
      ? c.req.query('toko_id')
        ? await validasiTokoIdMilikTenant(db, session, c.req.query('toko_id'))
        : session.toko_id
      : session.toko_id;
  if (!tokoId) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);

  const row = await db
    .prepare(`SELECT value FROM pengaturan WHERE toko_id = ? AND key = 'admin_tabs_enabled'`)
    .bind(tokoId)
    .first<{ value: string }>();
  const enabled = row?.value ? JSON.parse(row.value) : [...DAFTAR_TAB_ADMIN];
  return c.json({ success: true, data: { enabled_tabs: enabled } });
});

auth.put('/tabs-cabang', requireAuth, async (c) => {
  // requireRole inline untuk akses route ini dari settings (bukan hanya auth)
  const session = c.get('session');
  if (session.role !== 'super_admin') {
    return c.json({ success: false, error: 'Anda tidak memiliki akses untuk aksi ini' }, 403);
  }
  try {
    const db = c.env.DB;
    const body = await c.req.json<{ toko_id?: number; enabled_tabs?: string[] }>();
    const tokoId = body.toko_id
      ? await validasiTokoIdMilikTenant(db, session, body.toko_id)
      : session.toko_id;
    if (!tokoId) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);

    const enabled = Array.isArray(body.enabled_tabs)
      ? body.enabled_tabs.filter((t) => (DAFTAR_TAB_ADMIN as readonly string[]).includes(t))
      : [...DAFTAR_TAB_ADMIN];

    await db
      .prepare(
        `INSERT INTO pengaturan (toko_id, key, value, updated_at) VALUES (?, 'admin_tabs_enabled', ?, datetime('now'))
         ON CONFLICT(toko_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .bind(tokoId, JSON.stringify(enabled))
      .run();

    return c.json({ success: true, data: { enabled_tabs: enabled } });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan kebijakan tab' }, 400);
  }
});

export default auth;
