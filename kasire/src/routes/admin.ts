import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth-middleware';
import { hashPassword } from '../lib/crypto';
import type { AppEnv } from '../lib/types';
import { STRUK_SETTING_DEFAULTS } from '../lib/types';
import { catatLog, validasiTokoIdMilikTenant, getTokoIdsUntukTenant } from '../lib/helpers';

// Tiap sub-router di-mount sendiri di index.ts dengan prefix yang tepat.
// Ini berarti path di sini RELATIF terhadap prefix mount-nya.
// Contoh: admin.toko di-mount di '/api/toko', jadi '/' di sini = GET /api/toko

// ==========================================================
// TOKO (mount di /api/toko)
// ==========================================================

export const tokoRoutes = new Hono<AppEnv>();

tokoRoutes.get('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { results } = await db
    .prepare('SELECT * FROM toko WHERE toko_pusat_id = ? ORDER BY id ASC')
    .bind(session.toko_pusat_id)
    .all();
  return c.json({ success: true, data: results });
});

tokoRoutes.post('/', requireAuth, requireRole('super_admin'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const { nama, alamat } = await c.req.json<{ nama?: string; alamat?: string }>();
    if (!nama?.trim()) return c.json({ success: false, error: 'Nama toko wajib diisi' }, 400);

    const result = await db
      .prepare('INSERT INTO toko (toko_pusat_id, nama, alamat) VALUES (?, ?, ?)')
      .bind(session.toko_pusat_id, nama.trim(), alamat?.trim() ?? null)
      .run();
    await catatLog(db, session, 'tambah', 'toko', result.meta.last_row_id, `Buat cabang "${nama.trim()}"`);
    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch {
    return c.json({ success: false, error: 'Gagal membuat toko baru' }, 500);
  }
});

tokoRoutes.put('/:id', requireAuth, requireRole('super_admin'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const { nama, alamat } = await c.req.json<{ nama?: string; alamat?: string }>();
    if (!nama?.trim()) return c.json({ success: false, error: 'Nama toko wajib diisi' }, 400);

    const tokoId = await validasiTokoIdMilikTenant(db, session, id);
    if (!tokoId) return c.json({ success: false, error: 'Toko tidak ditemukan' }, 404);

    const namaBaru = nama.trim();

    // Sync ke store_settings.store_name supaya nama di etalase publik ikut
    // berubah ketika admin mengganti nama toko dari tab "Data Toko".
    // Pakai batch: (1) update toko, (2) INSERT OR IGNORE baris store_settings
    // kalau belum ada, (3) UPDATE store_name saja — field lain (wa_number,
    // logo, dll.) tidak disentuh, jadi setting etalase lain tetap aman.
    await db.batch([
      db.prepare('UPDATE toko SET nama = ?, alamat = ? WHERE id = ?')
        .bind(namaBaru, alamat?.trim() ?? null, tokoId),
      db.prepare(
        `INSERT INTO store_settings (toko_id, store_name) VALUES (?, ?)
         ON CONFLICT(toko_id) DO UPDATE SET store_name = excluded.store_name`
      ).bind(tokoId, namaBaru),
    ]);

    await catatLog(db, session, 'ubah', 'toko', tokoId, `Edit cabang "${namaBaru}"`);
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal memperbarui data toko' }, 500);
  }
});

// ==========================================================
// KATEGORI (mount di /api/kategori)
// ==========================================================

export const kategoriRoutes = new Hono<AppEnv>();

kategoriRoutes.get('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { results } = await db
    .prepare('SELECT * FROM kategori WHERE toko_pusat_id = ? ORDER BY urutan ASC, nama ASC')
    .bind(session.toko_pusat_id)
    .all();
  return c.json({ success: true, data: results });
});

kategoriRoutes.post('/', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const { nama, slug, urutan } = await c.req.json<any>();
    if (!nama?.trim()) return c.json({ success: false, error: 'Nama kategori wajib diisi' }, 400);

    const slugFinal =
      slug?.trim() ||
      nama.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const result = await db
      .prepare('INSERT INTO kategori (toko_pusat_id, nama, slug, urutan) VALUES (?, ?, ?, ?)')
      .bind(session.toko_pusat_id, nama.trim(), slugFinal, urutan ?? 0)
      .run();
    await catatLog(db, session, 'tambah', 'kategori', result.meta.last_row_id, `Buat kategori "${nama.trim()}"`);
    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (err: any) {
    const msg = String(err?.message ?? '').includes('UNIQUE')
      ? 'Slug kategori sudah dipakai, gunakan slug lain'
      : 'Gagal menambah kategori';
    return c.json({ success: false, error: msg }, 400);
  }
});

kategoriRoutes.put('/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const { nama, slug, urutan } = await c.req.json<any>();
    if (!nama?.trim()) return c.json({ success: false, error: 'Nama kategori wajib diisi' }, 400);

    const kat = await db
      .prepare('SELECT * FROM kategori WHERE id = ? AND toko_pusat_id = ?')
      .bind(id, session.toko_pusat_id)
      .first<any>();
    if (!kat) return c.json({ success: false, error: 'Kategori tidak ditemukan' }, 404);

    const slugFinal =
      slug?.trim() ||
      nama.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    await db
      .prepare('UPDATE kategori SET nama = ?, slug = ?, urutan = ? WHERE id = ?')
      .bind(nama.trim(), slugFinal, urutan ?? 0, id)
      .run();
    await catatLog(db, session, 'ubah', 'kategori', id, `Edit kategori "${nama.trim()}"`);
    return c.json({ success: true });
  } catch (err: any) {
    const msg = String(err?.message ?? '').includes('UNIQUE')
      ? 'Slug kategori sudah dipakai, gunakan slug lain'
      : 'Gagal memperbarui kategori';
    return c.json({ success: false, error: msg }, 400);
  }
});

kategoriRoutes.delete('/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');

  const kat = await db
    .prepare('SELECT * FROM kategori WHERE id = ? AND toko_pusat_id = ?')
    .bind(id, session.toko_pusat_id)
    .first<any>();
  if (!kat) return c.json({ success: false, error: 'Kategori tidak ditemukan' }, 404);

  await db.batch([
    db.prepare('DELETE FROM kategori WHERE id = ?').bind(id),
    db.prepare('UPDATE produk SET kategori_id = NULL WHERE kategori_id = ?').bind(id),
  ]);
  await catatLog(db, session, 'hapus', 'kategori', id, `Hapus kategori "${kat.nama}"`);
  return c.json({ success: true });
});

// ==========================================================
// PENGATURAN APLIKASI (mount di /api/settings)
// ==========================================================

export const settingsRoutes = new Hono<AppEnv>();

// GET /api/settings — soft auth (boleh tanpa login untuk app_title)
settingsRoutes.get('/', async (c) => {
  const db = c.env.DB;
  let toko_id: number | null = null;

  try {
    const { verifyToken } = await import('../lib/crypto');
    const { getCookie } = await import('hono/cookie');
    const token = getCookie(c, 'kasir_session');
    if (token) {
      const s = await verifyToken(token, c.env.JWT_SECRET);
      toko_id = s?.toko_id ?? null;
    }
  } catch { /* token opsional */ }

  if (!toko_id) {
    const first = await db.prepare('SELECT id FROM toko ORDER BY id ASC LIMIT 1').first<{ id: number }>();
    toko_id = first?.id ?? null;
  }
  if (!toko_id) return c.json({ success: true, data: {} });

  const { results } = await db
    .prepare('SELECT key, value FROM pengaturan WHERE toko_id = ?')
    .bind(toko_id)
    .all<{ key: string; value: string }>();

  const settings: Record<string, string> = { ...STRUK_SETTING_DEFAULTS };
  for (const row of results) settings[row.key] = row.value;
  return c.json({ success: true, data: settings });
});

settingsRoutes.put('/', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<Record<string, string>>();

    const tokoId =
      session.role === 'super_admin'
        ? await validasiTokoIdMilikTenant(db, session, body.toko_id ?? String(session.toko_id ?? ''))
        : session.toko_id;
    if (!tokoId) return c.json({ success: false, error: 'toko_id tidak valid' }, 400);

    const KUNCI_DIIZINKAN = new Set([
      'app_title', 'struk_footer', 'struk_catatan', 'struk_lebar_kertas',
      'struk_tampilkan_alamat', 'struk_footer_ikon', 'struk_qr_data',
      'admin_tabs_enabled',
    ]);
    const stmts = Object.entries(body)
      .filter(([k]) => KUNCI_DIIZINKAN.has(k) && k !== 'toko_id')
      .map(([k, v]) =>
        db.prepare(
          `INSERT INTO pengaturan (toko_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(toko_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        ).bind(tokoId, k, String(v))
      );

    if (stmts.length > 0) await db.batch(stmts);
    await catatLog(db, session, 'ubah', 'pengaturan', tokoId, `Update pengaturan aplikasi toko id=${tokoId}`);
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan pengaturan' }, 500);
  }
});

// ==========================================================
// ETALASE (mount di /api/etalase)
// ==========================================================

export const etalaseRoutes = new Hono<AppEnv>();

etalaseRoutes.get('/settings', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  const toko_id =
    session.role === 'super_admin'
      ? c.req.query('toko_id')
        ? await validasiTokoIdMilikTenant(db, session, c.req.query('toko_id'))
        : session.toko_id
      : session.toko_id;
  if (!toko_id) return c.json({ success: false, error: 'toko_id wajib ditentukan' }, 400);

  const row = await db.prepare('SELECT * FROM store_settings WHERE toko_id = ?').bind(toko_id).first();
  return c.json({ success: true, data: row ?? null });
});

etalaseRoutes.put('/settings', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<any>();

    const tokoId =
      session.role === 'super_admin'
        ? await validasiTokoIdMilikTenant(db, session, body.toko_id ?? String(session.toko_id ?? ''))
        : session.toko_id;
    if (!tokoId) return c.json({ success: false, error: 'toko_id tidak valid' }, 400);

    const TEMA_VALID = ['default', 'shopee', 'tiktokshop'];
    const tema = TEMA_VALID.includes(body.theme) ? body.theme : 'default';

    // FIX BUG: PUT /api/toko/:id sudah sync toko.nama → store_settings.store_name,
    // tapi arah sebaliknya tidak ada. Kalau admin update store_name dari tab
    // Etalase, toko.nama di tab Data Toko tidak ikut berubah — dua field diverge.
    // Solusi: batch kedua operasi sekaligus (atomic).
    // Catatan: hanya update toko.nama kalau store_name memang dikirim (tidak null).
    const storeNameBaru = body.store_name ?? null;
    const batchStmts: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO store_settings
           (toko_id, store_name, logo_key, wa_number, address, operating_hours,
            description, banner_text, banner_image_key, theme, checkout_message_template)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(toko_id) DO UPDATE SET
           store_name               = excluded.store_name,
           logo_key                 = excluded.logo_key,
           wa_number                = excluded.wa_number,
           address                  = excluded.address,
           operating_hours          = excluded.operating_hours,
           description              = excluded.description,
           banner_text              = excluded.banner_text,
           banner_image_key         = excluded.banner_image_key,
           theme                    = excluded.theme,
           checkout_message_template= excluded.checkout_message_template`
      ).bind(
        tokoId,
        storeNameBaru, body.logo_key ?? null, body.wa_number ?? null,
        body.address ?? null, body.operating_hours ?? null, body.description ?? null,
        body.banner_text ?? null, body.banner_image_key ?? null,
        tema, body.checkout_message_template ?? null
      ),
    ];

    // Sync balik ke toko.nama hanya kalau store_name dikirim dan tidak kosong
    if (storeNameBaru?.trim()) {
      batchStmts.push(
        db.prepare(`UPDATE toko SET nama = ? WHERE id = ?`).bind(storeNameBaru.trim(), tokoId)
      );
    }

    await db.batch(batchStmts);

    await catatLog(db, session, 'ubah', 'etalase_settings', tokoId, `Update pengaturan etalase toko id=${tokoId}`);
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan pengaturan etalase' }, 500);
  }
});

etalaseRoutes.get('/orders', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);

  let sql = `SELECT o.*, t.nama as toko_nama FROM orders o
             JOIN toko t ON t.id = o.toko_id
             WHERE t.toko_pusat_id = ?`;
  const params: any[] = [session.toko_pusat_id];

  if (session.role !== 'super_admin') { sql += ' AND o.toko_id = ?'; params.push(session.toko_id); }
  sql += ' ORDER BY o.created_at DESC LIMIT ?'; params.push(limit);

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// ==========================================================
// USERS (mount di /api/users)
// ==========================================================

export const usersRoutes = new Hono<AppEnv>();

usersRoutes.get('/', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  let sql = `SELECT u.id, u.username, u.nama_lengkap, u.role, u.toko_id, u.is_active,
                    t.nama as toko_nama,
                    CASE WHEN EXISTS (
                      SELECT 1 FROM shift_kasir sk
                      WHERE sk.kasir_id = u.id AND sk.status = 'buka'
                    ) THEN 1 ELSE 0 END as shift_aktif
             FROM users u LEFT JOIN toko t ON t.id = u.toko_id
             WHERE u.toko_pusat_id = ?`;
  const params: any[] = [session.toko_pusat_id];

  if (session.role === 'admin_toko') {
    sql += " AND (u.toko_id = ? OR (u.role = 'super_admin' AND u.toko_pusat_id = ?))";
    params.push(session.toko_id, session.toko_pusat_id);
  }
  sql += ' ORDER BY u.role ASC, u.nama_lengkap ASC';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

usersRoutes.post('/', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<any>();
    const { username, password, nama_lengkap, role } = body;

    if (!username?.trim() || !password || !nama_lengkap?.trim() || !role) {
      return c.json({ success: false, error: 'username, password, nama_lengkap, dan role wajib diisi' }, 400);
    }
    if (String(password).length < 6) return c.json({ success: false, error: 'Password minimal 6 karakter' }, 400);

    const ROLE_VALID = ['super_admin', 'admin_toko', 'kasir'];
    if (!ROLE_VALID.includes(role)) {
      return c.json({ success: false, error: `Role tidak valid. Pilihan: ${ROLE_VALID.join(', ')}` }, 400);
    }
    if (session.role === 'admin_toko' && role === 'super_admin') {
      return c.json({ success: false, error: 'Anda tidak bisa membuat akun super_admin' }, 403);
    }

    let toko_id: number | null = null;
    if (role !== 'super_admin') {
      toko_id =
        session.role === 'super_admin'
          ? await validasiTokoIdMilikTenant(db, session, body.toko_id)
          : session.toko_id;
      if (!toko_id) return c.json({ success: false, error: 'toko_id wajib ditentukan untuk kasir dan admin_toko' }, 400);
    }

    const { hash, salt } = await hashPassword(password);
    const result = await db
      .prepare(
        'INSERT INTO users (username, password_hash, password_salt, nama_lengkap, role, toko_pusat_id, toko_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(username.trim(), hash, salt, nama_lengkap.trim(), role, session.toko_pusat_id, toko_id)
      .run();

    await catatLog(db, session, 'tambah', 'user', result.meta.last_row_id,
      `Buat user "${username.trim()}" (${role})${toko_id ? ` di toko id=${toko_id}` : ''}`
    );
    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (err: any) {
    const msg = String(err?.message ?? '').includes('UNIQUE')
      ? 'Username sudah dipakai, pilih username lain'
      : 'Gagal membuat user';
    return c.json({ success: false, error: msg }, 400);
  }
});

usersRoutes.put('/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = Number(c.req.param('id'));
    const body = await c.req.json<any>();

    const target = await db
      .prepare('SELECT * FROM users WHERE id = ? AND toko_pusat_id = ?')
      .bind(id, session.toko_pusat_id)
      .first<any>();
    if (!target) return c.json({ success: false, error: 'User tidak ditemukan' }, 404);

    if (session.role === 'admin_toko' && target.role === 'super_admin' && target.id !== session.uid) {
      return c.json({ success: false, error: 'Anda tidak memiliki akses untuk mengedit akun super_admin' }, 403);
    }

    const perubahan: string[] = [];
    const stmts: any[] = [];

    if (body.password) {
      if (String(body.password).length < 6) return c.json({ success: false, error: 'Password baru minimal 6 karakter' }, 400);
      const { hash, salt } = await hashPassword(body.password);
      stmts.push(
        db.prepare('UPDATE users SET password_hash=?, password_salt=?, failed_attempts=0, locked_until=NULL WHERE id=?')
          .bind(hash, salt, id)
      );
      perubahan.push('reset password');
    }

    if (body.nama_lengkap != null && body.nama_lengkap !== target.nama_lengkap) {
      stmts.push(db.prepare('UPDATE users SET nama_lengkap=? WHERE id=?').bind(body.nama_lengkap.trim(), id));
      perubahan.push(`nama: "${target.nama_lengkap}" → "${body.nama_lengkap.trim()}"`);
    }

    if (body.is_active != null && Number(body.is_active) !== target.is_active) {
      if (id === session.uid) return c.json({ success: false, error: 'Anda tidak bisa menonaktifkan akun sendiri' }, 400);
      stmts.push(db.prepare('UPDATE users SET is_active=? WHERE id=?').bind(Number(body.is_active) ? 1 : 0, id));
      perubahan.push(Number(body.is_active) ? 'diaktifkan kembali' : 'dinonaktifkan');
    }

    if (body.toko_id != null && body.toko_id !== target.toko_id && target.role !== 'super_admin') {
      if (session.role !== 'super_admin') {
        return c.json({ success: false, error: 'Hanya super_admin yang bisa memindah user antar toko' }, 403);
      }
      const tokoIdBaru = await validasiTokoIdMilikTenant(db, session, body.toko_id);
      if (!tokoIdBaru) return c.json({ success: false, error: 'toko_id tujuan tidak valid' }, 400);
      stmts.push(db.prepare('UPDATE users SET toko_id=? WHERE id=?').bind(tokoIdBaru, id));
      perubahan.push(`pindah ke toko id=${tokoIdBaru}`);
    }

    if (stmts.length > 0) await db.batch(stmts);
    await catatLog(db, session, 'ubah', 'user', id,
      perubahan.length > 0
        ? `Edit user "${target.username}": ${perubahan.join('; ')}`
        : `Edit user "${target.username}" (tidak ada perubahan signifikan)`
    );
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal memperbarui user' }, 500);
  }
});

// ==========================================================
// LOG AKTIVITAS (mount di /api/log-aktivitas)
// ==========================================================

export const logRoutes = new Hono<AppEnv>();

logRoutes.get('/', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);

  // FIX BUG: super_admin punya toko_id = NULL, sehingga log mereka
  // (toko_id NULL) tidak pernah cocok dengan IN (SELECT id FROM toko ...).
  // Solusi: sertakan baris log milik tenant ini (via JOIN ke users untuk
  // konfirmasi toko_pusat_id), DITAMBAH baris dengan toko_id IS NULL yang
  // user_id-nya memang milik tenant yang sama.
  //
  // Untuk admin_toko: tetap filter hanya toko sendiri (toko_id = ?).
  // Untuk super_admin: tampilkan log semua cabang tenant + log aksi
  // super_admin sendiri (toko_id NULL, tapi toko_pusat_id-nya sama).
  let sql: string;
  const params: any[] = [];

  if (session.role === 'admin_toko') {
    sql = `SELECT la.* FROM log_aktivitas la
           WHERE la.toko_id = ?
           ORDER BY la.created_at DESC LIMIT ?`;
    params.push(session.toko_id, limit);
  } else {
    // super_admin: log dari semua cabang tenant + log super_admin sendiri (toko_id NULL)
    sql = `SELECT la.* FROM log_aktivitas la
           WHERE (
             la.toko_id IN (SELECT id FROM toko WHERE toko_pusat_id = ?)
             OR (
               la.toko_id IS NULL
               AND la.user_id IN (SELECT id FROM users WHERE toko_pusat_id = ?)
             )
           )
           ORDER BY la.created_at DESC LIMIT ?`;
    params.push(session.toko_pusat_id, session.toko_pusat_id, limit);
  }

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// ==========================================================
// ADMIN TOOLS (mount di /api/admin)
// ==========================================================

export const adminToolsRoutes = new Hono<AppEnv>();

adminToolsRoutes.post('/reset-data', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  try {
    const { konfirmasi, toko_id: bodyTokoId } = await c.req.json<any>();
    const FRASA = 'HAPUS SEMUA DATA';
    if (konfirmasi !== FRASA) {
      return c.json(
        { success: false, error: `Ketik "${FRASA}" (huruf besar persis) untuk konfirmasi reset data` },
        400
      );
    }

    const tokoId =
      session.role === 'super_admin'
        ? await validasiTokoIdMilikTenant(db, session, bodyTokoId ?? String(session.toko_id ?? ''))
        : session.toko_id;
    if (!tokoId) return c.json({ success: false, error: 'toko_id tidak valid' }, 400);

    // FIX BUG: order_items merujuk produk_id; setelah orders dihapus,
    // order_items menjadi orphan dan sold_count di storefront etalase kacau.
    // Hapus order_items dulu (child), baru orders (parent).
    // Log aktivitas: hanya hapus log berdasarkan toko_id (log super_admin
    // yang toko_id=NULL dibiarkan — itu log lintas-cabang, bukan per-toko).
    await db.batch([
      db.prepare('DELETE FROM retur_item WHERE retur_id IN (SELECT id FROM retur WHERE toko_id = ?)').bind(tokoId),
      db.prepare('DELETE FROM retur WHERE toko_id = ?').bind(tokoId),
      db.prepare('DELETE FROM transaksi_pembayaran WHERE transaksi_id IN (SELECT id FROM transaksi WHERE toko_id = ?)').bind(tokoId),
      db.prepare('DELETE FROM detail_transaksi WHERE transaksi_id IN (SELECT id FROM transaksi WHERE toko_id = ?)').bind(tokoId),
      db.prepare('DELETE FROM riwayat_stok WHERE produk_id IN (SELECT id FROM produk WHERE toko_id = ?)').bind(tokoId),
      db.prepare('DELETE FROM transaksi WHERE toko_id = ?').bind(tokoId),
      db.prepare('DELETE FROM shift_kasir WHERE toko_id = ?').bind(tokoId),
      db.prepare('DELETE FROM log_aktivitas WHERE toko_id = ?').bind(tokoId),
      // FIX: hapus riwayat pesanan WA toko ini beserta itemnya
      db.prepare('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE toko_id = ?)').bind(tokoId),
      db.prepare('DELETE FROM orders WHERE toko_id = ?').bind(tokoId),
    ]);

    await catatLog(db, session, 'reset', 'transaksi', tokoId, `Reset semua data transaksi toko id=${tokoId}`);
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal mereset data' }, 500);
  }
});
