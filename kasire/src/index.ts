import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { hashPassword, verifyPassword, signToken, verifyToken, type SessionPayload } from './lib/crypto';
import { requireAuth, requireRole, SESSION_COOKIE, type AppEnv } from './lib/auth-middleware';

const app = new Hono<AppEnv>();

// ==========================================================
// 1. MIDDLEWARE GLOBAL
// ==========================================================

// CORS harus di urutan PALING ATAS, sebelum middleware lain, agar preflight
// (OPTIONS) request tidak ikut diblokir oleh geo-restriction di bawah.
app.use('/*', async (c, next) => {
  const corsMiddleware = cors({
    origin: c.env.ALLOWED_ORIGIN ? c.env.ALLOWED_ORIGIN.split(',') : ['http://localhost:8787'],
    credentials: true,
  });
  return corsMiddleware(c, next);
});

// Geo-Restriction (PRD Bagian 9) — dikontrol lewat env var ENFORCE_GEO agar
// bisa dimatikan saat testing/dev tanpa ubah kode. `cf` object hanya tersedia
// di edge Cloudflare sungguhan (undefined saat `wrangler dev` lokal), jadi
// tetap aman dipakai lokal walau ENFORCE_GEO="true".
app.use('/*', async (c, next) => {
  if (c.env.ENFORCE_GEO === 'true') {
    const country = (c.req.raw as any).cf?.country;
    if (country !== undefined && country !== 'ID') {
      return c.json({ success: false, error: 'Akses ditolak (restriksi geografis)' }, 403);
    }
  }
  await next();
});

// ==========================================================
// 2. HELPER
// ==========================================================

function kodeTransaksi(): string {
  const now = new Date();
  const tgl = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  // FIX: sebelumnya 4 digit acak (1000-9999 = 9000 kemungkinan/hari) --
  // dengan birthday paradox, toko yang transaksi 100x/hari sudah py ~42%
  // peluang TABRAKAN kode_transaksi SETIAP HARI (UNIQUE constraint di DB),
  // dan 200x/hari ~89%. 6 digit (900.000 kemungkinan) turunkan risiko itu
  // jauh lebih rendah, TAPI tetap dipasangkan dengan retry di pemanggilnya
  // (POST /api/transaksi) sebagai jaring pengaman -- probabilitas kecil
  // bukan nol, jangan cuma andalkan entropi doang.
  const rand = Math.floor(100000 + Math.random() * 900000); // 6 digit
  return `TRX-${tgl}-${rand}`;
}

const METODE_BAYAR_VALID = ['cash', 'transfer', 'qris', 'debit'] as const;
type MetodeBayar = (typeof METODE_BAYAR_VALID)[number];

interface PembayaranInput {
  metode: MetodeBayar;
  jumlah: number;
}

/**
 * Validasi & hitung ringkasan split payment (bisa 1 metode atau lebih).
 * Aturan bisnis: kelebihan bayar (kembalian) HANYA sah untuk metode 'cash',
 * karena QRIS/transfer/debit adalah nominal digital yang pasti (tidak ada
 * "kembalian" fisik). Jadi non-cash tidak boleh melebihi sisa tagihan
 * setelah dikurangi metode non-cash lain; cash yang menutup sisanya.
 */
function hitungSplitPayment(
  pembayaran: any,
  totalBayar: number
): { ok: true; entries: PembayaranInput[]; cashTotal: number; kembalian: number; metodeFinal: string } | { ok: false; error: string } {
  if (!Array.isArray(pembayaran) || pembayaran.length === 0) {
    return { ok: false, error: 'Rincian pembayaran wajib diisi (minimal 1 metode)' };
  }

  const entries: PembayaranInput[] = [];
  for (const p of pembayaran) {
    const metode = p?.metode;
    const jumlah = Number(p?.jumlah);
    if (!METODE_BAYAR_VALID.includes(metode)) {
      return { ok: false, error: `Metode pembayaran tidak valid: ${metode}` };
    }
    if (!Number.isFinite(jumlah) || jumlah <= 0) {
      return { ok: false, error: 'Setiap jumlah pembayaran harus berupa angka lebih besar dari 0' };
    }
    entries.push({ metode, jumlah });
  }

  const cashTotal = entries.filter((e) => e.metode === 'cash').reduce((s, e) => s + e.jumlah, 0);
  const nonCashTotal = entries.filter((e) => e.metode !== 'cash').reduce((s, e) => s + e.jumlah, 0);

  if (nonCashTotal > totalBayar + 0.01) {
    return {
      ok: false,
      error: 'Pembayaran non-tunai melebihi total tagihan — kembalian hanya berlaku untuk pembayaran tunai',
    };
  }

  const sisaSetelahNonCash = totalBayar - nonCashTotal;
  if (cashTotal < sisaSetelahNonCash - 0.01) {
    const kurang = sisaSetelahNonCash - cashTotal;
    return { ok: false, error: `Total pembayaran kurang Rp ${Math.ceil(kurang).toLocaleString('id-ID')}` };
  }

  const kembalian = Math.round((cashTotal - sisaSetelahNonCash) * 100) / 100;
  const metodeUnik = new Set(entries.map((e) => e.metode));
  const metodeFinal = metodeUnik.size > 1 ? 'split' : entries[0].metode;

  return { ok: true, entries, cashTotal, kembalian, metodeFinal };
}

// WIB = UTC+7. Semua kolom created_at disimpan UTC oleh SQLite/D1
// (datetime('now')). Helper ini menggeser waktu ke WIB SEBELUM dibandingkan
// per-tanggal, supaya laporan "hari ini"/filter tanggal tidak meleset untuk
// transaksi yang terjadi jam 00:00–06:59 WIB (yang secara UTC masih "kemarin").
// Catatan: hardcode +7 jam karena PRD fokus Indonesia (geo-restriction ID).
// Kalau nanti ekspansi ke zona waktu lain (WITA/WIT), ini perlu dibuat dinamis.
function wibDateExpr(column: string): string {
  return `date(datetime(${column}, '+7 hours'))`;
}

function todayWIB(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Ambil produk berdasarkan ID, sekaligus validasi kepemilikan toko untuk
 * role admin_toko (agar admin toko A tidak bisa mengubah produk toko B).
 * super_admin bisa akses semua toko.
 */
/** Semua toko_id di dalam 1 toko_pusat_id (tenant) tertentu. */
async function getTokoIdsUntukTenant(db: D1Database, tokoPusatId: number): Promise<number[]> {
  const { results } = await db.prepare('SELECT id FROM toko WHERE toko_pusat_id = ?').bind(tokoPusatId).all<{ id: number }>();
  return results.map((r) => r.id);
}

/**
 * Daftar toko_id yang boleh diakses sesi ini:
 * - kasir/admin_toko: cuma toko_id mereka sendiri (1 elemen).
 * - super_admin: SEMUA cabang DI DALAM toko_pusat_id mereka -- BUKAN semua
 *   toko di seluruh database (itu beda tenant, harus tidak kelihatan sama
 *   sekali). Dipakai utk query "lihat semua" yang di-scope tenant.
 */
async function getTokoIdsUntukSesi(db: D1Database, session: SessionPayload): Promise<number[]> {
  if (session.role !== 'super_admin') {
    return session.toko_id ? [session.toko_id] : [];
  }
  return getTokoIdsUntukTenant(db, session.toko_pusat_id);
}

/**
 * Validasi toko_id yang diminta lewat query/body (biasanya oleh super_admin
 * yang pilih cabang mana yang mau dikelola) itu BENERAN cabang di dalam
 * toko_pusat_id sesi ini. Return null kalau tidak valid/bukan tenant sendiri
 * -- WAJIB dipanggil di setiap endpoint yang menerima toko_id dari
 * client (query param atau body), supaya super_admin tenant A tidak bisa
 * baca/tulis data tenant B cuma dengan ganti angka toko_id di request.
 */
async function validasiTokoIdMilikTenant(
  db: D1Database,
  session: SessionPayload,
  tokoId: number | string | null | undefined
): Promise<number | null> {
  if (!tokoId) return null;
  const row = await db
    .prepare('SELECT id FROM toko WHERE id = ? AND toko_pusat_id = ?')
    .bind(tokoId, session.toko_pusat_id)
    .first();
  return row ? Number(tokoId) : null;
}

async function getProdukAtauTolak(
  db: D1Database,
  id: string | number | undefined,
  session: SessionPayload
): Promise<{ produk: any } | { error: Response }> {
  if (!id) {
    return { error: Response.json({ success: false, error: 'ID produk tidak valid' }, { status: 400 }) };
  }
  const produk = await db
    .prepare('SELECT p.*, t.toko_pusat_id FROM produk p JOIN toko t ON t.id = p.toko_id WHERE p.id = ?')
    .bind(id)
    .first<any>();
  if (!produk) {
    return { error: Response.json({ success: false, error: 'Produk tidak ditemukan' }, { status: 404 }) };
  }
  // FIX (security, KRITIS): super_admin SEBELUMNYA sama sekali tidak dicek
  // kepemilikan tenant di sini -- bisa lihat/ubah/hapus/koreksi-stok/kelola
  // galeri produk MILIK TENANT LAIN. Helper ini dipakai 6+ endpoint sekaligus
  // jadi 1 baris ini kemarin bikin bocor semua-muanya.
  if (produk.toko_pusat_id !== session.toko_pusat_id) {
    return { error: Response.json({ success: false, error: 'Produk tidak ditemukan' }, { status: 404 }) };
  }
  if (session.role !== 'super_admin' && produk.toko_id !== session.toko_id) {
    return { error: Response.json({ success: false, error: 'Produk ini bukan milik toko Anda' }, { status: 403 }) };
  }
  return { produk };
}

/**
 * Catat satu baris audit trail ke `log_aktivitas`. Dipanggil "fire and forget"
 * (tidak di-await secara blocking terhadap response) untuk aksi CRUD non-kritis
 * (produk/user/toko/kategori/pembatalan transaksi) — beda dari riwayat_stok yang
 * WAJIB atomik dengan mutasi stok. Gagal mencatat log TIDAK BOLEH menggagalkan
 * aksi utamanya, jadi errornya cukup di-swallow (di-log ke console saja).
 */
async function catatLog(
  db: D1Database,
  session: { uid: number; role: string; toko_id: number | null },
  aksi: 'tambah' | 'ubah' | 'hapus' | 'nonaktifkan' | 'batalkan' | 'reset' | 'retur',
  entitas: 'produk' | 'user' | 'toko' | 'kategori' | 'transaksi' | 'pengaturan' | 'etalase_settings',
  entitas_id: number | string | null | undefined,
  keterangan: string,
  usernamePelaku?: string
): Promise<void> {
  try {
    let username = usernamePelaku;
    if (!username) {
      const u = await db.prepare('SELECT username FROM users WHERE id = ?').bind(session.uid).first<any>();
      username = u?.username ?? `user#${session.uid}`;
    }
    await db
      .prepare(
        `INSERT INTO log_aktivitas (user_id, username, toko_id, aksi, entitas, entitas_id, keterangan)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(session.uid, username, session.toko_id ?? null, aksi, entitas, entitas_id ?? null, keterangan)
      .run();
  } catch (err) {
    console.error('Gagal mencatat log_aktivitas:', err);
  }
}

// Root "/" tidak match file statis apa pun (html_handling = "none" sengaja
// mematikan auto-serve index.html di root, lihat catatan di wrangler.toml),
// jadi tanpa route eksplisit ini request ke domain polos jatuh ke
// app.notFound() dan menampilkan JSON "Endpoint tidak ditemukan" alih-alih
// membuka halaman login. Redirect biasa (bukan file dari cache SW) sehingga
// aman dari isu "redirected response" yang disebutkan di sw.js.
// Redirect root ("/") dipindah ke wrapper fetch() paling bawah file ini —
// supaya tahu prefix "/kasir" dan bisa redirect ke path yang benar
// (c.redirect di sini tidak tahu-menahu soal prefix mount eksternal).

// ==========================================================
// 3. ROUTES: AUTENTIKASI
// ==========================================================

app.post('/api/auth/login', async (c) => {
  try {
    const { username, password } = await c.req.json<{ username?: string; password?: string }>();
    if (!username || !password) {
      return c.json({ success: false, error: 'Username dan password wajib diisi' }, 400);
    }

    const db = c.env.DB;
    const user = await db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .bind(username)
      .first<any>();

    // Selalu jalankan verifyPassword walau user tidak ditemukan (dummy hash+salt)
    // agar waktu respons konsisten dan tidak membocorkan apakah username valid (timing attack).
    const isValid = user
      ? await verifyPassword(password, user.password_hash, user.password_salt)
      : await verifyPassword(password, '', 'AAAAAAAAAAAAAAAAAAAAAA==');

    if (!user || !isValid) {
      return c.json({ success: false, error: 'Username atau password salah' }, 401);
    }

    const exp = Math.floor(Date.now() / 1000) + 8 * 60 * 60; // 8 jam, sesuai shift kasir
    const token = await signToken(
      { uid: user.id, role: user.role, toko_pusat_id: user.toko_pusat_id, toko_id: user.toko_id ?? null, exp },
      c.env.JWT_SECRET
    );

    setCookie(c, SESSION_COOKIE, token, {
      path: '/',
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
  } catch (err: any) {
    return c.json({ success: false, error: 'Kesalahan server internal' }, 500);
  }
});

app.post('/api/auth/logout', async (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

app.get('/api/auth/me', requireAuth, async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const user = await db
    .prepare('SELECT id, username, nama_lengkap, role, toko_pusat_id, toko_id, hidden_tabs FROM users WHERE id = ? AND is_active = 1')
    .bind(session.uid)
    .first<any>();

  if (!user) return c.json({ success: false, error: 'User tidak ditemukan' }, 404);
  user.hidden_tabs = user.hidden_tabs ? JSON.parse(user.hidden_tabs) : [];
  return c.json({ success: true, user });
});

const DAFTAR_TAB_ADMIN = ['dashboard', 'produk', 'kasir', 'toko', 'log', 'riwayat', 'etalase', 'pengaturan'];

// Preferensi PRIBADI: tab admin mana yang mau disembunyikan oleh akun ini
// sendiri (murni tampilan -- endpoint API tab terkait TETAP bisa diakses
// lewat request langsung, sesuai keputusan: ini bukan kontrol akses).
// Siapa pun yang login boleh atur punya sendiri, tidak perlu requireRole.
app.put('/api/auth/me/tabs', requireAuth, async (c) => {
  try {
    const session = c.get('session');
    const db = c.env.DB;
    const body = await c.req.json<{ hidden_tabs?: string[] }>();
    const hidden = Array.isArray(body.hidden_tabs) ? body.hidden_tabs.filter((t) => DAFTAR_TAB_ADMIN.includes(t)) : [];

    await db.prepare('UPDATE users SET hidden_tabs = ? WHERE id = ?').bind(JSON.stringify(hidden), session.uid).run();
    return c.json({ success: true, hidden_tabs: hidden });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan preferensi tampilan' }, 400);
  }
});

// Kebijakan GLOBAL per-cabang: tab admin mana yang AKTIF utk admin_toko di
// cabang itu (super_admin tidak pernah dibatasi kebijakan ini di cabang
// mana pun -- cuma preferensi pribadinya sendiri di atas yang berlaku ke
// dia). Disimpan di tabel `pengaturan` (key 'admin_tabs_enabled', per
// toko_id) -- tabel yang sama dipakai utk app_title/struk, tidak perlu
// tabel baru.
app.get('/api/settings/tabs-cabang', requireAuth, async (c) => {
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
  const enabled = row?.value ? JSON.parse(row.value) : DAFTAR_TAB_ADMIN; // default: semua aktif
  return c.json({ success: true, data: { enabled_tabs: enabled } });
});

app.put('/api/settings/tabs-cabang', requireAuth, requireRole('super_admin'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<{ toko_id?: number; enabled_tabs?: string[] }>();
    const tokoId = body.toko_id ? await validasiTokoIdMilikTenant(db, session, body.toko_id) : session.toko_id;
    if (!tokoId) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);

    const enabled = Array.isArray(body.enabled_tabs)
      ? body.enabled_tabs.filter((t) => DAFTAR_TAB_ADMIN.includes(t))
      : DAFTAR_TAB_ADMIN;

    await db
      .prepare(
        `INSERT INTO pengaturan (toko_id, key, value, updated_at) VALUES (?, 'admin_tabs_enabled', ?, datetime('now'))
         ON CONFLICT(toko_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .bind(tokoId, JSON.stringify(enabled))
      .run();

    await catatLog(db, session, 'ubah', 'pengaturan', tokoId, 'Ubah kebijakan tab admin per cabang');
    return c.json({ success: true, data: { enabled_tabs: enabled } });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan kebijakan tab' }, 400);
  }
});

// Ganti password sendiri (butuh password lama) — beda dari reset password oleh
// admin lewat PUT /api/users/:id yang tidak perlu tahu password lama.
app.post('/api/auth/change-password', requireAuth, async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const { password_lama, password_baru } = await c.req.json<{ password_lama?: string; password_baru?: string }>();

    if (!password_lama || !password_baru) {
      return c.json({ success: false, error: 'Password lama dan password baru wajib diisi' }, 400);
    }
    if (String(password_baru).length < 6) {
      return c.json({ success: false, error: 'Password baru minimal 6 karakter' }, 400);
    }

    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').bind(session.uid).first<any>();
    if (!user) return c.json({ success: false, error: 'User tidak ditemukan' }, 404);

    const valid = await verifyPassword(password_lama, user.password_hash, user.password_salt);
    if (!valid) return c.json({ success: false, error: 'Password lama salah' }, 401);

    const { hash, salt } = await hashPassword(password_baru);
    await db
      .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .bind(hash, salt, session.uid)
      .run();

    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal mengubah password' }, 500);
  }
});

// ==========================================================
// 4. ROUTES: PRODUK
// ==========================================================

app.get('/api/produk', requireAuth, async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const { kategori_id, search } = c.req.query();

    // Kasir & admin_toko hanya lihat produk tokonya sendiri; super_admin bisa
    // semua cabang DALAM TENANT-NYA (bukan seluruh database -- opsional
    // filter ?toko_id= tetap divalidasi harus cabang tenant sendiri).
    let tokoIdList: number[];
    if (session.role === 'super_admin') {
      const qToko = c.req.query('toko_id');
      if (qToko) {
        const valid = await validasiTokoIdMilikTenant(db, session, qToko);
        if (!valid) return c.json({ success: false, error: 'toko_id tidak valid' }, 400);
        tokoIdList = [valid];
      } else {
        tokoIdList = await getTokoIdsUntukSesi(db, session);
      }
    } else {
      tokoIdList = session.toko_id ? [session.toko_id] : [];
    }
    if (tokoIdList.length === 0) return c.json({ success: true, data: [] });

    let sql = `
      SELECT p.*, k.nama as kategori_nama
      FROM produk p
      LEFT JOIN kategori k ON k.id = p.kategori_id
      WHERE p.is_active = 1`;
    const params: any[] = [];

    sql += ` AND p.toko_id IN (${tokoIdList.map(() => '?').join(',')})`;
    params.push(...tokoIdList);
    if (kategori_id) {
      sql += ' AND p.kategori_id = ?';
      params.push(kategori_id);
    }
    if (search) {
      sql += ' AND (p.nama LIKE ? OR p.kode_produk LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY p.nama ASC';

    const { results } = await db.prepare(sql).bind(...params).all();
    return c.json({ success: true, data: results });
  } catch (err: any) {
    return c.json({ success: false, error: 'Gagal mengambil data produk' }, 500);
  }
});

/**
 * FIX (integritas data): harga_jual/harga_beli/stok sebelumnya diterima apa
 * adanya dari body tanpa validasi tipe/rentang — bisa jadi NaN, negatif, atau
 * string kalau body dimodifikasi manual (endpoint ini memang dibatasi role
 * admin, tapi tetap defense-in-depth: harga negatif pada satu produk bisa
 * dipakai untuk mengimbangi/menurunkan total_bayar transaksi lain yang
 * memuatnya, mirip celah yang sudah diperbaiki pada diskon/pajak transaksi).
 */
function validasiHargaStok(body: any): { ok: true } | { ok: false; error: string } {
  const hargaJual = Number(body.harga_jual);
  if (!Number.isFinite(hargaJual) || hargaJual <= 0) {
    return { ok: false, error: 'harga_jual harus berupa angka lebih besar dari 0' };
  }
  if (body.harga_beli != null) {
    const hargaBeli = Number(body.harga_beli);
    if (!Number.isFinite(hargaBeli) || hargaBeli < 0) {
      return { ok: false, error: 'harga_beli harus berupa angka >= 0' };
    }
  }
  if (body.stok != null) {
    const stok = Number(body.stok);
    if (!Number.isFinite(stok) || !Number.isInteger(stok) || stok < 0) {
      return { ok: false, error: 'stok awal harus berupa bilangan bulat >= 0' };
    }
  }
  return { ok: true };
}

app.post('/api/produk', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<any>();
    const toko_id = session.role === 'super_admin' ? await validasiTokoIdMilikTenant(db, session, body.toko_id) : session.toko_id;
    if (!toko_id) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);

    if (!body.kode_produk || !body.nama || body.harga_jual == null) {
      return c.json({ success: false, error: 'kode_produk, nama, dan harga_jual wajib diisi' }, 400);
    }
    const validasi = validasiHargaStok(body);
    if (!validasi.ok) return c.json({ success: false, error: validasi.error }, 400);

    // Batas langganan: 200 produk AKTIF gabungan semua CABANG DALAM 1 TENANT
    // (toko_pusat_id) -- BUKAN gabungan seluruh database (itu akan mencampur
    // kuota bisnis yang berbeda-beda, tidak terkait satu sama lain).
    const tokoIdsTenant = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    const placeholders = tokoIdsTenant.map(() => '?').join(',');
    const jumlahProduk = await db
      .prepare(`SELECT COUNT(*) as total FROM produk WHERE is_active = 1 AND toko_id IN (${placeholders})`)
      .bind(...tokoIdsTenant)
      .first<{ total: number }>();
    if ((jumlahProduk?.total ?? 0) >= PRODUK_MAX_TOTAL) {
      return c.json({ success: false, error: PESAN_UPGRADE_PRODUK }, 403);
    }

    const result = await db
      .prepare(
        `INSERT INTO produk (toko_id, kategori_id, kode_produk, nama, harga_beli, harga_jual, stok, satuan, gambar_url,
                              slug, deskripsi_toko, harga_coret, tampil_online)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        toko_id,
        body.kategori_id ?? null,
        body.kode_produk,
        body.nama,
        body.harga_beli ?? 0,
        body.harga_jual,
        body.stok ?? 0,
        body.satuan ?? 'pcs',
        body.gambar_url ?? null,
        body.slug?.trim() || null,
        body.deskripsi_toko ?? null,
        body.harga_coret ?? null,
        body.tampil_online ? 1 : 0
      )
      .run();

    await catatLog(
      db,
      session,
      'tambah',
      'produk',
      result.meta.last_row_id,
      `Menambah produk "${body.nama}" (${body.kode_produk}), harga jual ${body.harga_jual}`
    );

    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (err: any) {
    const pesan = String(err.message ?? '');
    const msg = pesan.includes('idx_produk_slug')
      ? 'Slug etalase sudah dipakai produk lain, ganti slug-nya'
      : pesan.includes('UNIQUE')
        ? 'Kode produk/barcode sudah dipakai'
        : 'Gagal menambah produk';
    return c.json({ success: false, error: msg }, 400);
  }
});

app.put('/api/produk/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const body = await c.req.json<any>();

    if (body.harga_jual == null) {
      return c.json({ success: false, error: 'harga_jual wajib diisi' }, 400);
    }
    const validasi = validasiHargaStok(body);
    if (!validasi.ok) return c.json({ success: false, error: validasi.error }, 400);

    const check = await getProdukAtauTolak(db, id, session);
    if ('error' in check) return check.error;
    const produkLama = check.produk;

    await db
      .prepare(
        `UPDATE produk SET nama = ?, kategori_id = ?, harga_beli = ?, harga_jual = ?, satuan = ?,
         gambar_url = ?, slug = ?, deskripsi_toko = ?, harga_coret = ?, tampil_online = ?,
         updated_at = datetime('now') WHERE id = ?`
      )
      .bind(
        body.nama,
        body.kategori_id ?? null,
        body.harga_beli ?? 0,
        body.harga_jual,
        body.satuan ?? 'pcs',
        body.gambar_url ?? null,
        body.slug?.trim() || null,
        body.deskripsi_toko?.trim() || null,
        body.harga_coret ?? null,
        body.tampil_online ? 1 : 0,
        id
      )
      .run();

    // Foto lama yang kita simpan sendiri di R2 (bukan URL eksternal) dan sudah
    // diganti dengan foto lain (atau dihapus) tidak dipakai lagi — bersihkan
    // supaya bucket tidak terus membengkak dengan foto yatim. Best-effort:
    // kalau gagal (jaringan dsb), tidak menggagalkan penyimpanan produknya.
    const keyLama = r2KeyDariGambarUrl(produkLama.gambar_url);
    if (keyLama && produkLama.gambar_url !== body.gambar_url) {
      c.executionCtx.waitUntil(c.env.IMAGES.delete(keyLama).catch(() => {}));
    }

    // Catat perubahan spesifik (nama & harga) supaya log berguna untuk investigasi,
    // bukan cuma "produk diubah" yang tidak informatif.
    const perubahan: string[] = [];
    if (produkLama.nama !== body.nama) perubahan.push(`nama: "${produkLama.nama}" -> "${body.nama}"`);
    if (Number(produkLama.harga_jual) !== Number(body.harga_jual)) {
      perubahan.push(`harga jual: Rp${Number(produkLama.harga_jual).toLocaleString('id-ID')} -> Rp${Number(body.harga_jual).toLocaleString('id-ID')}`);
    }
    if (Number(produkLama.harga_beli ?? 0) !== Number(body.harga_beli ?? 0)) {
      perubahan.push(`harga beli: Rp${Number(produkLama.harga_beli ?? 0).toLocaleString('id-ID')} -> Rp${Number(body.harga_beli ?? 0).toLocaleString('id-ID')}`);
    }
    await catatLog(
      db,
      session,
      'ubah',
      'produk',
      id,
      perubahan.length > 0 ? `Ubah produk "${produkLama.nama}": ${perubahan.join('; ')}` : `Ubah produk "${produkLama.nama}" (tanpa perubahan harga/nama)`
    );

    return c.json({ success: true });
  } catch (err: any) {
    const msg = String(err.message ?? '').includes('idx_produk_slug')
      ? 'Slug etalase sudah dipakai produk lain, ganti slug-nya'
      : 'Gagal mengubah produk';
    return c.json({ success: false, error: msg }, 400);
  }
});

app.delete('/api/produk/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');

  const check = await getProdukAtauTolak(db, id, session);
  if ('error' in check) return check.error;

  await db.prepare('UPDATE produk SET is_active = 0 WHERE id = ?').bind(id).run();
  await catatLog(db, session, 'nonaktifkan', 'produk', id, `Menonaktifkan produk "${check.produk.nama}"`);
  return c.json({ success: true });
});

// Koreksi stok manual — WAJIB tercatat di riwayat_stok (PRD 7.2)
app.post('/api/produk/:id/koreksi-stok', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = Number(c.req.param('id'));
    const { jumlah, alasan } = await c.req.json<{ jumlah: number; alasan?: string }>();

    if (!Number.isInteger(jumlah) || jumlah === 0) {
      return c.json({ success: false, error: 'jumlah wajib berupa bilangan bulat bukan nol (negatif untuk koreksi turun, positif untuk koreksi naik)' }, 400);
    }

    const check = await getProdukAtauTolak(db, id, session);
    if ('error' in check) return check.error;
    const produk = check.produk;

    const stokSebelum = produk.stok as number;
    const stokSesudah = stokSebelum + jumlah;

    await db.batch([
      db.prepare(`UPDATE produk SET stok = ?, updated_at = datetime('now') WHERE id = ?`).bind(stokSesudah, id),
      db
        .prepare(
          `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
           VALUES (?, 'koreksi', ?, ?, ?, ?, ?)`
        )
        .bind(id, jumlah, stokSebelum, stokSesudah, alasan ?? 'Koreksi manual', session.uid),
    ]);

    return c.json({ success: true, stok_sesudah: stokSesudah });
  } catch (err: any) {
    return c.json({ success: false, error: 'Gagal melakukan koreksi stok' }, 500);
  }
});

// ==========================================================
// 4a2. ROUTES: UPLOAD & SERVE FOTO PRODUK (Cloudflare R2)
//
// Admin bisa upload foto langsung dari perangkat (bukan cuma tempel URL
// eksternal). File disimpan di R2, lalu diserve lewat GET /api/gambar/:key
// dari Worker yang sama — jadi tidak perlu setup akses publik R2 terpisah
// (r2.dev subdomain / custom domain) dan tidak kena masalah CORS.
// ==========================================================

const GAMBAR_MIME_VALID: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const GAMBAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB — cukup besar untuk foto produk terkompresi, cukup kecil untuk edge cepat

// ==========================================================
// BATAS LANGGANAN (global, gabungan SEMUA toko — bukan per-toko)
// ==========================================================
const PRODUK_MAX_TOTAL = 200;
const R2_MAX_BYTES_TOTAL = 500 * 1024 * 1024; // 500MB
const PESAN_UPGRADE_PRODUK = 'Batas maksimal 200 produk (gabungan semua toko) sudah tercapai. Upgrade langganan untuk menambah kuota.';
const PESAN_UPGRADE_R2 = 'Batas maksimal 500MB penyimpanan gambar (gabungan semua toko) sudah tercapai. Upgrade langganan untuk menambah kuota.';

/**
 * Jumlahkan total ukuran semua object di R2 bucket IMAGES (byte), dengan
 * pagination (R2 list() maks 1000 key per panggilan). Tidak pakai counter
 * terpisah di DB supaya selalu akurat & self-healing walau ada upload/hapus
 * yang gagal setengah jalan -- trade-off: 1x R2 list loop tiap kali admin
 * mau upload gambar baru, bukan operasi yang sering terjadi jadi biaya ini
 * diterima demi akurasi.
 */
async function hitungTotalUkuranR2(bucket: R2Bucket, prefix?: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor, limit: 1000, prefix });
    for (const obj of listed.objects) total += obj.size;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}

// Kuota R2 SEKARANG DIHITUNG PER TENANT (toko_pusat_id), bukan lagi total
// seluruh bucket (yang berarti tenant A penuh bisa menghambat tenant B
// upload, padahal 2 bisnis berbeda -- lihat ARSITEKTUR.md §8). Key R2
// sekarang selalu diprefix "produk/{toko_pusat_id}/..." (foto utama produk,
// ditulis kasire) & "etalase/{toko_pusat_id}/..." (galeri/logo/banner) --
// list-by-prefix dari R2 dipakai supaya tidak perlu scan SELURUH bucket
// (lintas tenant) tiap kali cek kuota.
async function hitungTotalUkuranR2UntukTenant(bucket: R2Bucket, tokoPusatId: number): Promise<number> {
  const [produkBytes, etalaseBytes] = await Promise.all([
    hitungTotalUkuranR2(bucket, `produk/${tokoPusatId}/`),
    hitungTotalUkuranR2(bucket, `etalase/${tokoPusatId}/`),
  ]);
  return produkBytes + etalaseBytes;
}

// Kalau gambar_url mengarah ke foto yang kita simpan sendiri di R2
// (path /api/gambar/xxx), ambil key R2-nya. Kalau itu URL eksternal
// (https://...dari luar), return null — tidak ada yang perlu dibersihkan.
function r2KeyDariGambarUrl(gambarUrl: string | null | undefined): string | null {
  if (!gambarUrl) return null;
  // Terima baik URL relatif (/api/gambar/xxx) maupun absolut
  // (https://domain-kasir.com/api/gambar/xxx) — sejak endpoint upload
  // mengembalikan URL absolut supaya bisa dipakai lintas domain oleh
  // web toko, gambar_url yang tersimpan juga jadi absolut.
  const m = gambarUrl.match(/\/api\/gambar\/(.+)$/);
  return m ? m[1] : null;
}

app.post('/api/upload/produk', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const session = c.get('session');
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!(file instanceof File)) {
      return c.json({ success: false, error: 'File tidak ditemukan (field "file" wajib diisi)' }, 400);
    }
    const ext = GAMBAR_MIME_VALID[file.type];
    if (!ext) {
      return c.json({ success: false, error: 'Format tidak didukung. Pakai JPG, PNG, atau WEBP.' }, 400);
    }
    if (file.size > GAMBAR_MAX_BYTES) {
      return c.json({ success: false, error: `Ukuran file maksimal 2MB (file ini ${(file.size / 1024 / 1024).toFixed(1)}MB)` }, 400);
    }

    // Cek kuota R2 SEBELUM upload -- lebih baik gagal cepat di sini
    // daripada upload sukses lalu ternyata sudah kelebihan kuota. Kuota
    // di-scope PER TENANT (toko_pusat_id), bukan total seluruh bucket --
    // supaya tenant lain yang berbagi database yang sama tidak ikut
    // terhambat kalau tenant ini penuh.
    //
    // FIX edge-case: kalau ini upload PENGGANTI foto yang sudah ada (bukan
    // produk baru), frontend menyertakan old_gambar_url -- foto lama itu
    // akan dihapus SETELAH foto baru ini tersimpan (lihat PUT /api/produk/:id),
    // jadi ukurannya harus DIKECUALIKAN dari hitungan kuota di sini. Tanpa
    // ini, mengganti foto produk bisa ditolak salah persis saat bucket ada
    // di ambang batas 500MB, padahal net perubahannya (lama dihapus, baru
    // masuk) mungkin tidak menambah total sama sekali.
    const oldGambarUrl = typeof body['old_gambar_url'] === 'string' ? body['old_gambar_url'] : null;
    const oldKey = r2KeyDariGambarUrl(oldGambarUrl);
    let totalEfektif = await hitungTotalUkuranR2UntukTenant(c.env.IMAGES, session.toko_pusat_id);
    if (oldKey) {
      const oldObj = await c.env.IMAGES.head(oldKey);
      if (oldObj) totalEfektif -= oldObj.size;
    }
    if (totalEfektif + file.size > R2_MAX_BYTES_TOTAL) {
      const sisaMb = Math.max(0, (R2_MAX_BYTES_TOTAL - totalEfektif) / 1024 / 1024).toFixed(1);
      return c.json({ success: false, error: `${PESAN_UPGRADE_R2} (sisa kuota: ${sisaMb}MB)` }, 403);
    }

    const key = `produk/${session.toko_pusat_id}/${crypto.randomUUID()}.${ext}`;
    await c.env.IMAGES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });

    // URL ABSOLUT dengan prefix /kasir (kasire sekarang hidup di path
    // /kasir pada domain yang sama dengan etalase, lihat wrangler.toml
    // `routes`) — supaya tetap tampil benar kalau di-embed dari halaman
    // etalase (domain sama, tapi path beda). <img> tidak butuh CORS untuk
    // menampilkan gambar cross-path, jadi ini aman tanpa setup tambahan.
    const gambarUrl = `${new URL(c.req.url).origin}/kasir/api/gambar/${key}`;
    return c.json({ success: true, gambar_url: gambarUrl }, 201);
  } catch (err: any) {
    return c.json({ success: false, error: 'Gagal upload gambar' }, 500);
  }
});

// Publik (tanpa requireAuth) — supaya foto produk gampang ditampilkan lewat
// tag <img> biasa di mana saja (termasuk halaman cetak struk di tab baru)
// tanpa perlu ikut kirim cookie sesi. Key R2 sendiri sudah acak (UUID) jadi
// tidak bisa ditebak/di-enumerasi, dan isinya cuma foto produk, bukan data
// sensitif — jadi ini aman dipublikasikan.
app.get('/api/gambar/*', async (c) => {
  const key = c.req.path.replace(/^\/api\/gambar\//, '');
  const obj = await c.env.IMAGES.get(key);
  if (!obj) return c.json({ success: false, error: 'Gambar tidak ditemukan' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // Immutable: key selalu UUID baru per upload, jadi aman di-cache lama-lama di browser/edge.
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: obj.httpEtag,
      // FIX (defense-in-depth): cegah browser "menebak" tipe konten lain dari
      // Content-Type yang sudah eksplisit di atas (mis. kalau ada file yang lolos
      // whitelist MIME saat upload tapi isinya bukan gambar sungguhan).
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ==========================================================
// 4b. ROUTES: TOKO & KATEGORI (untuk dropdown form admin)
// ==========================================================

app.get('/api/toko', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  if (session.role === 'super_admin') {
    const { results } = await db
      .prepare('SELECT * FROM toko WHERE toko_pusat_id = ? ORDER BY nama ASC')
      .bind(session.toko_pusat_id)
      .all();
    return c.json({ success: true, data: results });
  }
  // admin_toko & kasir hanya lihat toko miliknya sendiri
  const toko = await db.prepare('SELECT * FROM toko WHERE id = ?').bind(session.toko_id).first();
  return c.json({ success: true, data: toko ? [toko] : [] });
});

app.post('/api/toko', requireAuth, requireRole('super_admin'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const { nama, alamat } = await c.req.json<any>();
    if (!nama) return c.json({ success: false, error: 'nama toko wajib diisi' }, 400);

    const result = await db
      .prepare('INSERT INTO toko (toko_pusat_id, nama, alamat) VALUES (?, ?, ?)')
      .bind(session.toko_pusat_id, nama, alamat ?? null)
      .run();
    await catatLog(db, session, 'tambah', 'toko', result.meta.last_row_id, `Menambah toko "${nama}"`);
    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch {
    return c.json({ success: false, error: 'Gagal menambah toko' }, 400);
  }
});

// FIX: sebelumnya hanya ada create (POST) toko, tidak ada endpoint untuk
// mengubah nama/alamat toko yang sudah ada — jadi nama toko tidak bisa
// diedit dari panel admin sama sekali. Ditambahkan PUT di sini.
app.put('/api/toko/:id', requireAuth, requireRole('super_admin'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const { nama, alamat } = await c.req.json<any>();
    if (!nama || !String(nama).trim()) {
      return c.json({ success: false, error: 'nama toko wajib diisi' }, 400);
    }

    const tokoLama = await db.prepare('SELECT nama FROM toko WHERE id = ? AND toko_pusat_id = ?').bind(id, session.toko_pusat_id).first<any>();
    if (!tokoLama) return c.json({ success: false, error: 'Toko tidak ditemukan' }, 404);

    await db.prepare('UPDATE toko SET nama = ?, alamat = ? WHERE id = ? AND toko_pusat_id = ?').bind(String(nama).trim(), alamat ?? null, id, session.toko_pusat_id).run();
    await catatLog(db, session, 'ubah', 'toko', id, `Mengubah toko "${tokoLama.nama}" menjadi "${String(nama).trim()}"`);
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal mengubah toko' }, 400);
  }
});

// ==========================================================
// 4c. ROUTES: PENGATURAN APLIKASI (key/value global, mis. judul aplikasi)
// ==========================================================

// PUBLIC (tanpa requireAuth) — sengaja, karena halaman login perlu menampilkan
// judul aplikasi SEBELUM user login.
// Kunci pengaturan struk yang boleh diubah lewat PUT /api/settings, beserta
// nilai default-nya kalau belum pernah diisi di DB (mis. instalasi lama
// sebelum migrasi 0006). Satu sumber kebenaran dipakai baik oleh GET maupun PUT.
const STRUK_SETTING_DEFAULTS: Record<string, string> = {
  struk_footer: 'Terima kasih atas kunjungan Anda',
  struk_catatan: '',
  struk_lebar_kertas: '58',
  struk_tampilkan_alamat: '1',
  struk_footer_ikon: 'tidak',
  struk_qr_data: '',
};

// Pengaturan (judul app + kustomisasi struk) — 1 SET PER CABANG (toko_id).
// GET dipakai juga oleh login.html SEBELUM login (tidak ada sesi/toko_id
// diketahui) -> auth di sini OPSIONAL (soft), bukan requireAuth: kalau ada
// cookie sesi valid, pakai toko_id dari situ; kalau tidak, balikin default
// sistem generik (bukan punya cabang tertentu -- itu prinsipnya, login.html
// sama utk semua cabang, baru setelah login tampilan ikut cabang masing2).
app.get('/api/settings', async (c) => {
  const db = c.env.DB;
  const keys = ['app_title', ...Object.keys(STRUK_SETTING_DEFAULTS)];

  let tokoId: number | string | null = null;
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await verifyToken(token, c.env.JWT_SECRET);
    if (session) {
      tokoId = session.role === 'super_admin'
        ? (c.req.query('toko_id') ? await validasiTokoIdMilikTenant(db, session, c.req.query('toko_id')) : session.toko_id)
        : session.toko_id;
    }
  }

  const data: Record<string, string> = { app_title: 'KASIR CLOUD' };
  for (const [key, def] of Object.entries(STRUK_SETTING_DEFAULTS)) data[key] = def;

  if (tokoId) {
    const placeholders = keys.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT key, value FROM pengaturan WHERE toko_id = ? AND key IN (${placeholders})`)
      .bind(tokoId, ...keys)
      .all<any>();
    const map = new Map(results.map((r: any) => [r.key, r.value]));
    if (map.has('app_title')) data.app_title = map.get('app_title');
    for (const key of Object.keys(STRUK_SETTING_DEFAULTS)) {
      if (map.has(key)) data[key] = map.get(key);
    }
  }

  return c.json({ success: true, data });
});

app.put('/api/settings', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<any>();
    const tokoId = session.role === 'super_admin' ? await validasiTokoIdMilikTenant(db, session, body.toko_id) ?? session.toko_id : session.toko_id;
    if (!tokoId) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);

    const { app_title } = body;
    if (!app_title || !String(app_title).trim()) {
      return c.json({ success: false, error: 'Judul aplikasi wajib diisi' }, 400);
    }
    const title = String(app_title).trim().slice(0, 60);

    // Kustomisasi struk — semua opsional, dipakai default kalau tidak dikirim.
    const lebarKertas = String(body.struk_lebar_kertas ?? STRUK_SETTING_DEFAULTS.struk_lebar_kertas).trim();
    if (!['58', '80'].includes(lebarKertas)) {
      return c.json({ success: false, error: 'Lebar kertas struk harus 58 atau 80 (mm)' }, 400);
    }
    const footer = String(body.struk_footer ?? STRUK_SETTING_DEFAULTS.struk_footer).trim().slice(0, 120);
    const catatan = String(body.struk_catatan ?? STRUK_SETTING_DEFAULTS.struk_catatan).trim().slice(0, 200);
    const tampilkanAlamat = String(body.struk_tampilkan_alamat ?? '1') === '1' ? '1' : '0';

    const footerIkon = String(body.struk_footer_ikon ?? STRUK_SETTING_DEFAULTS.struk_footer_ikon).trim();
    if (!['tidak', 'qr', 'judul'].includes(footerIkon)) {
      return c.json({ success: false, error: 'Ikon footer struk tidak valid' }, 400);
    }
    const qrData = String(body.struk_qr_data ?? STRUK_SETTING_DEFAULTS.struk_qr_data).trim().slice(0, 300);
    if (footerIkon === 'qr' && !qrData) {
      return c.json({ success: false, error: 'Data QR wajib diisi kalau ikon footer dipilih QR Code' }, 400);
    }

    const values: Record<string, string> = {
      app_title: title,
      struk_footer: footer,
      struk_catatan: catatan,
      struk_lebar_kertas: lebarKertas,
      struk_tampilkan_alamat: tampilkanAlamat,
      struk_footer_ikon: footerIkon,
      struk_qr_data: qrData,
    };

    const statements = Object.entries(values).map(([key, value]) =>
      db
        .prepare(
          `INSERT INTO pengaturan (toko_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(toko_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        )
        .bind(tokoId, key, value)
    );
    await db.batch(statements);

    await catatLog(db, session, 'ubah', 'pengaturan', tokoId, `Mengubah pengaturan aplikasi & kustomisasi struk`);
    return c.json({ success: true, data: values });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan pengaturan' }, 400);
  }
});

app.get('/api/kategori', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { results } = await db
    .prepare('SELECT * FROM kategori WHERE toko_pusat_id = ? ORDER BY urutan ASC, nama ASC')
    .bind(session.toko_pusat_id)
    .all();
  return c.json({ success: true, data: results });
});

app.post('/api/kategori', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const { nama, slug, urutan } = await c.req.json<any>();
    if (!nama) return c.json({ success: false, error: 'nama kategori wajib diisi' }, 400);

    const result = await db
      .prepare('INSERT INTO kategori (toko_pusat_id, nama, slug, urutan) VALUES (?, ?, ?, ?)')
      .bind(session.toko_pusat_id, nama, slug?.trim() || null, Number.isFinite(Number(urutan)) ? Number(urutan) : 0)
      .run();
    await catatLog(db, session, 'tambah', 'kategori', result.meta.last_row_id, `Menambah kategori "${nama}"`);
    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (err: any) {
    const msg = String(err.message ?? '').includes('idx_kategori_slug')
      ? 'Slug kategori sudah dipakai, ganti slug-nya'
      : 'Gagal menambah kategori';
    return c.json({ success: false, error: msg }, 400);
  }
});

// Dipakai panel "Etalase Online" (edit nama/slug/urutan kategori yang sudah
// ada) -- sebelumnya cuma ada create, tidak ada update.
app.put('/api/kategori/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const { nama, slug, urutan } = await c.req.json<any>();
    if (!nama) return c.json({ success: false, error: 'nama kategori wajib diisi' }, 400);

    const result = await db
      .prepare('UPDATE kategori SET nama = ?, slug = ?, urutan = ? WHERE id = ? AND toko_pusat_id = ?')
      .bind(nama, slug?.trim() || null, Number.isFinite(Number(urutan)) ? Number(urutan) : 0, id, session.toko_pusat_id)
      .run();
    if (result.meta.changes === 0) return c.json({ success: false, error: 'Kategori tidak ditemukan' }, 404);
    await catatLog(db, session, 'ubah', 'kategori', id, `Ubah kategori jadi "${nama}"`);
    return c.json({ success: true });
  } catch (err: any) {
    const msg = String(err.message ?? '').includes('idx_kategori_slug')
      ? 'Slug kategori sudah dipakai, ganti slug-nya'
      : 'Gagal mengubah kategori';
    return c.json({ success: false, error: msg }, 400);
  }
});

// Kategori dipakai bersama SEMUA CABANG DALAM 1 TENANT (bukan lintas
// tenant) -- produk yang memakainya TIDAK ikut terhapus, cuma jadi tanpa
// kategori (NULL).
app.delete('/api/kategori/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');

  const milik = await db.prepare('SELECT id FROM kategori WHERE id = ? AND toko_pusat_id = ?').bind(id, session.toko_pusat_id).first();
  if (!milik) return c.json({ success: false, error: 'Kategori tidak ditemukan' }, 404);

  await db.prepare('UPDATE produk SET kategori_id = NULL WHERE kategori_id = ?').bind(id).run();
  await db.prepare('DELETE FROM kategori WHERE id = ?').bind(id).run();
  await catatLog(db, session, 'hapus', 'kategori', id, `Hapus kategori`);
  return c.json({ success: true });
});

// ==========================================================
// 4a2. ROUTES: ETALASE ONLINE (dulu app terpisah "etalase", sekarang
//      dikelola dari sini juga -- 1 admin, 1 login, sesuai keputusan
//      penggabungan). Produk & kategori dasarnya tetap lewat endpoint
//      /api/produk & /api/kategori di atas (sudah diperluas dgn field
//      slug/deskripsi_toko/harga_coret/tampil_online). Bagian ini khusus
//      untuk hal yang TIDAK ada padanannya di kasir: galeri foto
//      tambahan, pengaturan tampilan etalase, & riwayat pesanan WA.
// ==========================================================

// Galeri foto tambahan per produk (foto UTAMA tetap lewat gambar_url di
// /api/produk, ini cuma foto pelengkap yang tampil di halaman detail toko).
app.get('/api/produk/:id/galeri', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');
  const check = await getProdukAtauTolak(db, id, session);
  if ('error' in check) return check.error;

  const { results } = await db
    .prepare('SELECT id, image_key, urutan FROM produk_galeri WHERE produk_id = ? ORDER BY urutan ASC, id ASC')
    .bind(id)
    .all();
  return c.json({ success: true, data: results });
});

app.post('/api/produk/:id/galeri', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const produkId = c.req.param('id');
    const check = await getProdukAtauTolak(db, produkId, session);
    if ('error' in check) return check.error;

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ success: false, error: 'File tidak ditemukan (field "file" wajib diisi)' }, 400);
    }
    const ext = GAMBAR_MIME_VALID[file.type];
    if (!ext) return c.json({ success: false, error: 'Format tidak didukung. Pakai JPG, PNG, atau WEBP.' }, 400);
    if (file.size > GAMBAR_MAX_BYTES) {
      return c.json({ success: false, error: `Ukuran file maksimal 2MB (file ini ${(file.size / 1024 / 1024).toFixed(1)}MB)` }, 400);
    }
    const totalEfektif = await hitungTotalUkuranR2UntukTenant(c.env.IMAGES, session.toko_pusat_id);
    if (totalEfektif + file.size > R2_MAX_BYTES_TOTAL) {
      const sisaMb = Math.max(0, (R2_MAX_BYTES_TOTAL - totalEfektif) / 1024 / 1024).toFixed(1);
      return c.json({ success: false, error: `${PESAN_UPGRADE_R2} (sisa kuota: ${sisaMb}MB)` }, 403);
    }

    const galeriCount = await db
      .prepare('SELECT COUNT(*) as total FROM produk_galeri WHERE produk_id = ?')
      .bind(produkId)
      .first<{ total: number }>();
    if ((galeriCount?.total ?? 0) >= 10) {
      return c.json({ success: false, error: 'Maksimal 10 foto galeri per produk' }, 400);
    }

    const key = `etalase/${session.toko_pusat_id}/${crypto.randomUUID()}.${ext}`;
    await c.env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

    const urutan = galeriCount?.total ?? 0;
    const result = await db
      .prepare('INSERT INTO produk_galeri (produk_id, image_key, urutan) VALUES (?, ?, ?)')
      .bind(produkId, key, urutan)
      .run();

    return c.json({ success: true, id: result.meta.last_row_id, image_key: key }, 201);
  } catch {
    return c.json({ success: false, error: 'Gagal upload foto galeri' }, 500);
  }
});

app.delete('/api/produk/:id/galeri/:galeriId', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');
  const check = await getProdukAtauTolak(db, id, session);
  if ('error' in check) return check.error;

  const galeriId = c.req.param('galeriId');
  const row = await db
    .prepare('SELECT image_key FROM produk_galeri WHERE id = ? AND produk_id = ?')
    .bind(galeriId, id)
    .first<{ image_key: string }>();
  if (!row) return c.json({ success: false, error: 'Foto tidak ditemukan' }, 404);

  await db.prepare('DELETE FROM produk_galeri WHERE id = ?').bind(galeriId).run();
  c.executionCtx.waitUntil(c.env.IMAGES.delete(row.image_key).catch(() => {}));
  return c.json({ success: true });
});

// Upload generik untuk aset etalase (logo & gambar banner) -- pola sama
// dengan /api/upload/produk, key R2 di-prefix "etalase/" biar rapi.
app.post('/api/upload/etalase', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const session = c.get('session');
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ success: false, error: 'File tidak ditemukan (field "file" wajib diisi)' }, 400);
    }
    const ext = GAMBAR_MIME_VALID[file.type];
    if (!ext) return c.json({ success: false, error: 'Format tidak didukung. Pakai JPG, PNG, atau WEBP.' }, 400);
    if (file.size > GAMBAR_MAX_BYTES) {
      return c.json({ success: false, error: `Ukuran file maksimal 2MB (file ini ${(file.size / 1024 / 1024).toFixed(1)}MB)` }, 400);
    }
    const totalEfektif = await hitungTotalUkuranR2UntukTenant(c.env.IMAGES, session.toko_pusat_id);
    if (totalEfektif + file.size > R2_MAX_BYTES_TOTAL) {
      const sisaMb = Math.max(0, (R2_MAX_BYTES_TOTAL - totalEfektif) / 1024 / 1024).toFixed(1);
      return c.json({ success: false, error: `${PESAN_UPGRADE_R2} (sisa kuota: ${sisaMb}MB)` }, 403);
    }
    const key = `etalase/${session.toko_pusat_id}/${crypto.randomUUID()}.${ext}`;
    await c.env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    const url = `${new URL(c.req.url).origin}/kasir/api/gambar/${key}`;
    return c.json({ success: true, url }, 201);
  } catch {
    return c.json({ success: false, error: 'Gagal upload gambar' }, 500);
  }
});

// Pengaturan tampilan etalase (nama toko, WA, jam buka, banner, tema, dll).
// 1 BARIS PER CABANG (toko_id) -- admin_toko otomatis kena baris tokonya
// sendiri; super_admin boleh pilih cabang mana lewat ?toko_id= (dipakai
// kalau kelola banyak cabang, mis. deploy multi-domain -- lihat
// ARSITEKTUR.md). Tanpa scoping ini, versi sebelumnya cuma ada 1 baris
// tetap (id=1) yang otomatis "bocor"/tercampur kalau dipakai lebih dari
// 1 cabang.
app.get('/api/etalase/settings', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const tokoId = session.role === 'super_admin'
    ? (c.req.query('toko_id') ? await validasiTokoIdMilikTenant(db, session, c.req.query('toko_id')) : session.toko_id)
    : session.toko_id;
  if (!tokoId) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);

  const row = await db.prepare('SELECT * FROM store_settings WHERE toko_id = ?').bind(tokoId).first();
  return c.json({ success: true, data: row });
});

app.put('/api/etalase/settings', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<any>();
    const tokoId = session.role === 'super_admin' ? (await validasiTokoIdMilikTenant(db, session, body.toko_id) ?? session.toko_id) : session.toko_id;
    if (!tokoId) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);
    if (!body.store_name?.trim() || !body.wa_number?.trim()) {
      return c.json({ success: false, error: 'Nama toko dan nomor WA wajib diisi' }, 400);
    }

    const allowedThemes = new Set(['default', 'shopee', 'tiktokshop']);
    const theme = allowedThemes.has(body.theme || '') ? body.theme : 'default';

    // Normalisasi nomor WA: hanya digit, ganti awalan 0 -> 62 (format
    // yang dibutuhkan link wa.me di halaman etalase).
    let waNumber = String(body.wa_number).replace(/[^0-9]/g, '');
    if (waNumber.startsWith('0')) waNumber = '62' + waNumber.slice(1);

    const newLogoKey = body.logo_key || null;
    const newBannerImageKey = body.banner_image_key || null;
    const existing = await db
      .prepare('SELECT logo_key, banner_image_key FROM store_settings WHERE toko_id = ?')
      .bind(tokoId)
      .first<{ logo_key: string | null; banner_image_key: string | null }>();

    // INSERT OR REPLACE: baris cabang ini mungkin belum ada (cabang baru
    // yang belum pernah disimpan pengaturannya sama sekali).
    await db
      .prepare(
        `INSERT INTO store_settings (toko_id, store_name, wa_number, address, operating_hours, description,
           banner_text, banner_image_key, logo_key, theme, checkout_message_template)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(toko_id) DO UPDATE SET
           store_name = excluded.store_name, wa_number = excluded.wa_number, address = excluded.address,
           operating_hours = excluded.operating_hours, description = excluded.description,
           banner_text = excluded.banner_text, banner_image_key = excluded.banner_image_key,
           logo_key = excluded.logo_key, theme = excluded.theme,
           checkout_message_template = excluded.checkout_message_template`
      )
      .bind(
        tokoId,
        body.store_name.trim(),
        waNumber,
        body.address?.trim() || null,
        body.operating_hours?.trim() || null,
        body.description?.trim() || null,
        body.banner_text?.trim() || null,
        newBannerImageKey,
        newLogoKey,
        theme,
        body.checkout_message_template?.trim() || 'Halo, saya mau pesan:\n{items}\n\nTotal: {total}\nNama: {nama}\nCatatan: {catatan}'
      )
      .run();

    // Logo/banner lama diganti -> bersihkan dari R2 supaya tidak jadi sampah.
    if (existing?.logo_key && existing.logo_key !== newLogoKey) {
      c.executionCtx.waitUntil(c.env.IMAGES.delete(existing.logo_key).catch(() => {}));
    }
    if (existing?.banner_image_key && existing.banner_image_key !== newBannerImageKey) {
      c.executionCtx.waitUntil(c.env.IMAGES.delete(existing.banner_image_key).catch(() => {}));
    }

    await catatLog(db, session, 'ubah', 'etalase_settings', tokoId, 'Ubah pengaturan tampilan etalase');
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal menyimpan pengaturan etalase' }, 400);
  }
});

// Riwayat pesanan checkout WhatsApp dari etalase (cuma log, BUKAN transaksi
// kasir -- lihat catatan di skema `orders`). Read-only, terbaru dulu.
// Di-scope per toko_id (sama seperti /api/transaksi) -- admin_toko HANYA
// lihat pesanan cabangnya sendiri, super_admin bebas/bisa filter ?toko_id=.
app.get('/api/etalase/orders', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 30, 1), 100);
  const beforeId = Number(c.req.query('before_id')) || null;
  let tokoIdList: number[];
  if (session.role === 'super_admin') {
    const qToko = c.req.query('toko_id');
    if (qToko) {
      const valid = await validasiTokoIdMilikTenant(db, session, qToko);
      if (!valid) return c.json({ success: false, error: 'toko_id tidak valid' }, 400);
      tokoIdList = [valid];
    } else {
      tokoIdList = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    }
  } else {
    tokoIdList = session.toko_id ? [session.toko_id] : [];
  }
  if (tokoIdList.length === 0) return c.json({ success: true, data: [] });

  let sql = `SELECT * FROM orders WHERE toko_id IN (${tokoIdList.map(() => '?').join(',')})`;
  const params: any[] = [...tokoIdList];
  if (beforeId) {
    sql += ' AND id < ?';
    params.push(beforeId);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ id: number; buyer_name: string; buyer_note: string | null; items_json: string; total: number; created_at: string }>();

  const orders = results.map((r) => ({
    id: r.id,
    buyer_name: r.buyer_name,
    buyer_note: r.buyer_note,
    items: JSON.parse(r.items_json),
    total: r.total,
    created_at: r.created_at,
  }));
  return c.json({ success: true, data: orders });
});



/**
 * Buka shift baru. Ditolak kalau kasir yang login masih punya shift 'buka'
 * yang belum ditutup — mencegah 1 kasir punya 2 shift aktif bersamaan
 * (bikin perhitungan kas sistem ambigu).
 */
app.post('/api/shift/buka', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  try {
    const { modal_awal } = await c.req.json<any>();
    const modalAwalNum = Number(modal_awal);
    if (!Number.isFinite(modalAwalNum) || modalAwalNum < 0) {
      return c.json({ success: false, error: 'Modal awal harus berupa angka >= 0' }, 400);
    }
    if (!session.toko_id) {
      return c.json({ success: false, error: 'Akun ini tidak terikat ke toko manapun' }, 400);
    }

    const existing = await db
      .prepare("SELECT id FROM shift_kasir WHERE kasir_id = ? AND status = 'buka'")
      .bind(session.uid)
      .first<any>();
    if (existing) {
      return c.json({ success: false, error: 'Kamu masih punya shift yang belum ditutup. Tutup shift itu dulu.' }, 409);
    }

    const result = await db
      .prepare('INSERT INTO shift_kasir (kasir_id, toko_id, modal_awal) VALUES (?, ?, ?)')
      .bind(session.uid, session.toko_id, modalAwalNum)
      .run();

    const shift = await db.prepare('SELECT * FROM shift_kasir WHERE id = ?').bind(result.meta.last_row_id).first();
    return c.json({ success: true, data: shift }, 201);
  } catch {
    return c.json({ success: false, error: 'Gagal membuka shift' }, 400);
  }
});

/** Shift yang sedang aktif (status='buka') milik kasir yang login, kalau ada. */
app.get('/api/shift/aktif', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  const shift = await db
    .prepare("SELECT * FROM shift_kasir WHERE kasir_id = ? AND status = 'buka' ORDER BY id DESC LIMIT 1")
    .bind(session.uid)
    .first<any>();

  if (!shift) return c.json({ success: true, data: null });

  // Total tunai yang sudah masuk sejauh ini di shift ini (buat ditampilkan
  // sebagai "perkiraan kas di laci" sebelum kasir menutup shift).
  //
  // PENTING: tp.jumlah untuk metode 'cash' adalah nominal yang DISERAHKAN
  // pelanggan (mis. bayar pakai uang Rp50.000 untuk tagihan Rp15.500), BUKAN
  // nominal yang benar-benar tersisa di laci setelah kembalian diberikan.
  // Kembalian HANYA pernah diambil dari cash (aturan bisnis di
  // hitungSplitPayment), jadi kas fisik bersih = total tunai diserahkan
  // dikurangi total kembalian yang sudah dikeluarkan sepanjang shift ini.
  //
  // FIX: retur yang dananya dikembalikan TUNAI (metode_pengembalian='cash')
  // juga mengeluarkan uang fisik dari laci -- tanpa dikurangi di sini, kas
  // sistem akan lebih besar dari kas fisik sungguhan sebesar total retur
  // tunai yang pernah terjadi selama shift ini, bikin kasir jujur selalu
  // terlihat "kurang" (lihat migrasi 0010).
  const kasSaatIni = await db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(tp.jumlah) FROM transaksi_pembayaran tp
                    JOIN transaksi t ON t.id = tp.transaksi_id
                    WHERE t.shift_id = ? AND tp.metode_bayar = 'cash' AND t.status = 'selesai'), 0) as total_tunai_diterima,
         COALESCE((SELECT SUM(t.kembalian) FROM transaksi t
                    WHERE t.shift_id = ? AND t.status = 'selesai'), 0) as total_kembalian,
         COALESCE((SELECT SUM(r.total_retur) FROM retur r
                    JOIN transaksi t ON t.id = r.transaksi_id
                    WHERE t.shift_id = ? AND r.metode_pengembalian = 'cash'), 0) as total_retur_tunai`
    )
    .bind(shift.id, shift.id, shift.id)
    .first<any>();
  const netTunai =
    (kasSaatIni?.total_tunai_diterima ?? 0) - (kasSaatIni?.total_kembalian ?? 0) - (kasSaatIni?.total_retur_tunai ?? 0);

  return c.json({
    success: true,
    data: { ...shift, perkiraan_kas_saat_ini: shift.modal_awal + netTunai },
  });
});

/**
 * Tutup shift aktif milik kasir yang login. Kas sistem dihitung otomatis dari
 * total pembayaran TUNAI (metode_bayar='cash' di transaksi_pembayaran) atas
 * transaksi yang tertaut ke shift ini — bukan dari total_bayar transaksi,
 * karena QRIS/debit/transfer tidak menambah uang fisik di laci kasir.
 */
app.post('/api/shift/tutup', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  try {
    const { kas_fisik_akhir, catatan } = await c.req.json<any>();
    const kasFisikNum = Number(kas_fisik_akhir);
    if (!Number.isFinite(kasFisikNum) || kasFisikNum < 0) {
      return c.json({ success: false, error: 'Kas fisik akhir harus berupa angka >= 0' }, 400);
    }

    const shift = await db
      .prepare("SELECT * FROM shift_kasir WHERE kasir_id = ? AND status = 'buka' ORDER BY id DESC LIMIT 1")
      .bind(session.uid)
      .first<any>();
    if (!shift) {
      return c.json({ success: false, error: 'Tidak ada shift aktif untuk ditutup' }, 404);
    }

    // PENTING: tp.jumlah untuk metode 'cash' adalah nominal yang DISERAHKAN
    // pelanggan, BUKAN nominal yang benar-benar tersisa di laci setelah
    // kembalian diberikan. Kembalian HANYA pernah diambil dari cash (aturan
    // bisnis di hitungSplitPayment), jadi kas fisik bersih = total tunai
    // diserahkan dikurangi total kembalian yang sudah dikeluarkan shift ini.
    // (Sebelum fix ini, kembalian sama sekali tidak dikurangi — kas sistem
    // akhir jadi jauh lebih besar dari kas fisik yang sesungguhnya ada.)
    //
    // FIX (migrasi 0010): retur yang dananya dikembalikan TUNAI juga
    // mengeluarkan uang fisik dari laci -- ikut dikurangi di sini, konsisten
    // dengan GET /api/shift/aktif.
    const rekap = await db
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(tp.jumlah) FROM transaksi_pembayaran tp
                      JOIN transaksi t ON t.id = tp.transaksi_id
                      WHERE t.shift_id = ? AND tp.metode_bayar = 'cash' AND t.status = 'selesai'), 0) as total_tunai_diterima,
           COALESCE((SELECT SUM(t.kembalian) FROM transaksi t
                      WHERE t.shift_id = ? AND t.status = 'selesai'), 0) as total_kembalian,
           COALESCE((SELECT SUM(r.total_retur) FROM retur r
                      JOIN transaksi t ON t.id = r.transaksi_id
                      WHERE t.shift_id = ? AND r.metode_pengembalian = 'cash'), 0) as total_retur_tunai`
      )
      .bind(shift.id, shift.id, shift.id)
      .first<any>();

    const netTunai =
      (rekap?.total_tunai_diterima ?? 0) - (rekap?.total_kembalian ?? 0) - (rekap?.total_retur_tunai ?? 0);
    const kasSistemAkhir = shift.modal_awal + netTunai;
    const selisih = Math.round((kasFisikNum - kasSistemAkhir) * 100) / 100;

    await db
      .prepare(
        `UPDATE shift_kasir
         SET status = 'tutup', waktu_tutup = datetime('now'),
             kas_sistem_akhir = ?, kas_fisik_akhir = ?, selisih = ?, catatan = ?
         WHERE id = ?`
      )
      .bind(kasSistemAkhir, kasFisikNum, selisih, catatan ?? null, shift.id)
      .run();

    const updated = await db.prepare('SELECT * FROM shift_kasir WHERE id = ?').bind(shift.id).first();
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Gagal menutup shift' }, 400);
  }
});

/** Riwayat shift — admin_toko lihat toko sendiri, super_admin lihat semua. */
app.get('/api/shift', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  let sql = `
    SELECT sk.*, u.nama_lengkap as kasir_nama, t.nama as toko_nama
    FROM shift_kasir sk
    JOIN users u ON u.id = sk.kasir_id
    JOIN toko t ON t.id = sk.toko_id
    WHERE t.toko_pusat_id = ?`;
  const params: any[] = [session.toko_pusat_id];

  if (session.role === 'admin_toko') {
    sql += ' AND sk.toko_id = ?';
    params.push(session.toko_id);
  }
  sql += ' ORDER BY sk.waktu_buka DESC LIMIT 100';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// ==========================================================
// 5. ROUTES: TRANSAKSI (BATCH ATOMIC)
// ==========================================================

app.post('/api/transaksi', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  try {
    const body = await c.req.json<any>();
    const { offline_uuid, items, diskon = 0, pajak = 0 } = body;
    const toko_id = session.toko_id ?? body.toko_id;
    const kasir_id = session.uid;

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: 'Item transaksi kosong' }, 400);
    }
    if (!toko_id) {
      return c.json({ success: false, error: 'toko_id tidak diketahui untuk user ini' }, 400);
    }

    // Validasi bentuk tiap item SEBELUM apa pun disentuh DB. `id` & `qty` dari
    // client boleh dipakai (menentukan barang & jumlah yang dibeli), tapi
    // `harga`/`nama` dari client TIDAK PERNAH dipakai untuk kalkulasi — harga
    // sesungguhnya selalu diambil ulang dari tabel `produk` di bawah, supaya
    // request yang dimodifikasi manual tidak bisa mengubah harga jual barang.
    for (const item of items) {
      if (typeof item?.id !== 'number') {
        return c.json({ success: false, error: 'ID produk tidak valid pada salah satu item' }, 400);
      }
      if (!Number.isInteger(item?.qty) || item.qty <= 0) {
        return c.json({ success: false, error: `Qty tidak valid untuk item id=${item?.id} (harus bilangan bulat > 0)` }, 400);
      }
      // Diskon per-item (opsional): nominal Rupiah, dikurangkan dari subtotal baris
      // ini SEBELUM diskon total transaksi diterapkan. Divalidasi penuh di bawah
      // (setelah harga_jual asli diketahui dari DB) karena batas atasnya bergantung
      // pada harga x qty, bukan bisa dicek di sini.
      if (item?.diskon_item != null && !Number.isFinite(Number(item.diskon_item))) {
        return c.json({ success: false, error: `Diskon item tidak valid untuk item id=${item?.id}` }, 400);
      }
    }

    // Tautkan transaksi ke shift aktif kasir (kalau ada) supaya kas sistem per-shift
    // bisa direkonsiliasi saat tutup shift. Untuk role 'kasir' ini WAJIB — mencegah
    // transaksi tunai "tidak tercatat" di shift manapun. Role admin tidak diblok
    // (mis. dipakai owner sesekali tanpa disiplin buka/tutup shift formal).
    const shiftAktif = await db
      .prepare("SELECT id FROM shift_kasir WHERE kasir_id = ? AND status = 'buka' ORDER BY id DESC LIMIT 1")
      .bind(kasir_id)
      .first<any>();
    if (!shiftAktif && session.role === 'kasir') {
      return c.json({ success: false, error: 'Belum ada shift aktif — buka shift dulu sebelum mulai transaksi' }, 409);
    }
    const shift_id = shiftAktif?.id ?? null;

    // Idempotency: cegah duplikasi saat sinkronisasi offline mengirim ulang
    if (offline_uuid) {
      const existing = await db
        .prepare('SELECT id, kode_transaksi FROM transaksi WHERE offline_uuid = ?')
        .bind(offline_uuid)
        .first<any>();
      if (existing) {
        return c.json({ success: true, message: 'Sudah tersinkronisasi sebelumnya', kode_transaksi: existing.kode_transaksi });
      }
    }

    // Ambil harga_jual, stok, status aktif & toko_id TERKINI dari DB untuk
    // semua produk sekaligus (satu query, hindari N+1) — ini SUMBER
    // KEBENARAN, bukan body request. Dipakai untuk validasi DAN kalkulasi
    // harga di bawah.
    const produkIds = [...new Set(items.map((i: any) => i.id))];
    const placeholders = produkIds.map(() => '?').join(',');
    const { results: produkRows } = await db
      .prepare(`SELECT id, nama, harga_jual, harga_beli, stok, is_active, toko_id FROM produk WHERE id IN (${placeholders})`)
      .bind(...produkIds)
      .all<any>();
    const produkMap = new Map(produkRows.map((p: any) => [p.id, p]));

    // Tolak kalau ada produk yang: tidak ditemukan, sudah dinonaktifkan
    // (soft-deleted), atau ternyata milik toko LAIN (mencegah kasir toko A
    // "membeli" produk toko B lewat request yang dimodifikasi manual).
    const tidakValid = items
      .filter((item: any) => {
        const p = produkMap.get(item.id);
        return !p || p.is_active !== 1 || p.toko_id !== toko_id;
      })
      .map((item: any) => item.id);
    if (tidakValid.length > 0) {
      return c.json(
        { success: false, error: `Produk tidak valid untuk transaksi ini (tidak ditemukan/nonaktif/beda toko): id ${tidakValid.join(', ')}` },
        400
      );
    }

    // Hitung subtotal dari harga_jual di DB (server-truth), bukan dari body,
    // dikurangi diskon per-item (kalau ada). diskonItemNum divalidasi di sini
    // (bukan di loop validasi bentuk di atas) karena batas atasnya baru
    // diketahui setelah harga_jual asli dari DB tersedia.
    let subtotal = 0;
    for (const item of items) {
      const produk = produkMap.get(item.id)!;
      const hargaAsliBaris = produk.harga_jual * item.qty;
      const diskonItemNum = Number(item.diskon_item ?? 0);
      if (diskonItemNum < 0) {
        return c.json({ success: false, error: `Diskon item tidak boleh negatif untuk item id=${item.id}` }, 400);
      }
      if (diskonItemNum > hargaAsliBaris + 0.01) {
        return c.json(
          { success: false, error: `Diskon item melebihi harga baris untuk "${produk.nama}"` },
          400
        );
      }
      subtotal += hargaAsliBaris - diskonItemNum;
    }

    // FIX (integritas keuangan): diskon & pajak sebelumnya dipakai APA ADANYA
    // dari body tanpa validasi — beda dari harga item yang sudah benar diambil
    // ulang dari DB. Client (termasuk kasir, role terendah) bisa mengirim
    // diskon lebih besar dari subtotal sehingga total_bayar negatif, yang
    // membuat hitungSplitPayment menghasilkan "kembalian" raksasa yang
    // tercatat seolah dibayarkan — sementara stok tetap terpotong seperti
    // transaksi normal. Karena semua endpoint /api/laporan/* menjumlah
    // total_bayar langsung dari tabel ini, nilai tak wajar ini akan
    // mengotori omzet harian, produk terlaris, dan rekonsiliasi kas shift.
    const diskonNum = Number(diskon);
    const pajakNum = Number(pajak);
    if (!Number.isFinite(diskonNum) || diskonNum < 0) {
      return c.json({ success: false, error: 'Diskon harus berupa angka >= 0' }, 400);
    }
    if (!Number.isFinite(pajakNum) || pajakNum < 0) {
      return c.json({ success: false, error: 'Pajak harus berupa angka >= 0' }, 400);
    }
    if (diskonNum > subtotal + 0.01) {
      return c.json({ success: false, error: 'Diskon tidak boleh melebihi subtotal belanja' }, 400);
    }

    const total_belanja = subtotal - diskonNum + pajakNum;
    const total_bayar = total_belanja;
    if (total_bayar <= 0) {
      return c.json({ success: false, error: 'Total tagihan harus lebih besar dari 0' }, 400);
    }

    // Format baru: body.pembayaran = [{ metode, jumlah }, ...] (mendukung split
    // payment, mis. sebagian cash + sebagian QRIS). Tetap menerima format lama
    // (metode_bayar + uang_diterima tunggal) untuk kompatibilitas mundur, mis.
    // antrian offline lama yang belum sempat ter-sync sebelum update ini.
    const pembayaranInput =
      body.pembayaran ??
      (body.metode_bayar
        ? [{ metode: body.metode_bayar, jumlah: body.metode_bayar === 'cash' ? body.uang_diterima ?? total_bayar : total_bayar }]
        : null);

    if (!pembayaranInput) {
      return c.json({ success: false, error: 'Rincian pembayaran (pembayaran atau metode_bayar) wajib diisi' }, 400);
    }

    const split = hitungSplitPayment(pembayaranInput, total_bayar);
    if (!split.ok) {
      return c.json({ success: false, error: split.error }, 400);
    }

    // FIX: kode_trx punya risiko TABRAKAN (birthday paradox -- toko dengan
    // volume transaksi tinggi bisa kena beberapa % per hari walau sudah pakai
    // 6 digit acak, lihat komentar di kodeTransaksi()). Sebelumnya tabrakan
    // ini bikin checkout gagal TOTAL dengan pesan error yang SALAH DIAGNOSIS
    // (selalu dikira offline_uuid collision, padahal constraint yang beda).
    // Sekarang: retry otomatis dengan kode_trx baru KHUSUS untuk tabrakan
    // kode_transaksi (dideteksi dari nama kolom di pesan error SQLite, D1
    // konsisten menyertakan itu) -- offline_uuid collision TETAP langsung
    // gagal tanpa retry (itu memang penanda transaksi ini sudah pernah
    // masuk, retry di sana justru salah/berbahaya, bisa duplikat).
    let kode_trx = kodeTransaksi();
    const MAX_PERCOBAAN_KODE_TRX = 3;

    for (let percobaan = 1; ; percobaan++) {
      const statements = [
        db
          .prepare(
            `INSERT INTO transaksi
             (kode_transaksi, toko_id, kasir_id, total_belanja, diskon, pajak, total_bayar, metode_bayar, uang_diterima, kembalian, offline_uuid, shift_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            kode_trx,
            toko_id,
            kasir_id,
            total_belanja,
            diskonNum,
            pajakNum,
            total_bayar,
            split.metodeFinal,
            split.cashTotal > 0 ? split.cashTotal : null,
            split.kembalian,
            offline_uuid ?? null,
            shift_id
          ),
      ];

      // Satu baris transaksi_pembayaran per metode yang benar-benar dipakai
      // (idempotency transaksi induknya sudah dijamin lewat offline_uuid di atas;
      // karena statement ini bagian dari batch atomik yang sama, tidak akan ada
      // baris pembayaran yatim jika transaksi gagal disimpan).
      for (const entry of split.entries) {
        statements.push(
          db
            .prepare(
              `INSERT INTO transaksi_pembayaran (transaksi_id, metode_bayar, jumlah)
               VALUES ((SELECT id FROM transaksi WHERE kode_transaksi = ?), ?, ?)`
            )
            .bind(kode_trx, entry.metode, entry.jumlah)
        );
      }

      // stokMap dipakai sebagai working copy agar item dengan produk_id yang sama
      // di keranjang (dua baris berbeda tapi produk sama) tetap dihitung berurutan.
      const stokMap = new Map(produkRows.map((p: any) => [p.id, p.stok as number]));

      for (const item of items) {
        const produk = produkMap.get(item.id)!;
        const stokSebelum = stokMap.get(item.id) ?? produk.stok;
        // Catatan PRD 8.4: stok BISA menjadi negatif akibat transaksi offline yang
        // di-sync belakangan — transaksi tetap diterima (barang fisik sudah terjual),
        // admin merekonsiliasi lewat /api/laporan/stok-menipis & riwayat_stok.
        const stokSesudah = stokSebelum - item.qty;
        stokMap.set(item.id, stokSesudah);

        const diskonItemNum = Number(item.diskon_item ?? 0);
        const subtotalBaris = produk.harga_jual * item.qty - diskonItemNum;

        statements.push(
          db
            .prepare(
              `INSERT INTO detail_transaksi (transaksi_id, produk_id, nama_produk, harga_satuan, qty, subtotal, hpp_satuan, diskon_item)
               VALUES ((SELECT id FROM transaksi WHERE kode_transaksi = ?), ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              kode_trx,
              item.id,
              produk.nama,
              produk.harga_jual,
              item.qty,
              subtotalBaris,
              produk.harga_beli ?? 0,
              diskonItemNum
            )
        );
        statements.push(
          db.prepare(`UPDATE produk SET stok = ?, updated_at = datetime('now') WHERE id = ?`).bind(stokSesudah, item.id)
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
               VALUES (?, 'keluar', ?, ?, ?, ?, ?)`
            )
            .bind(item.id, item.qty, stokSebelum, stokSesudah, kode_trx, kasir_id)
        );
      }

      try {
        // Eksekusi atomik: semua statement sukses, atau semua di-rollback oleh D1
        await db.batch(statements);
        break; // sukses, keluar dari retry loop
      } catch (err: any) {
        const pesanError = String(err?.message ?? '');
        const tabrakanKodeTrx = pesanError.includes('kode_transaksi');
        if (tabrakanKodeTrx && percobaan < MAX_PERCOBAAN_KODE_TRX) {
          kode_trx = kodeTransaksi(); // regenerate kode baru, coba lagi
          continue;
        }
        throw err; // offline_uuid collision (jangan retry) ATAU percobaan kode_trx habis
      }
    }

    return c.json({ success: true, kode_transaksi: kode_trx, kembalian: split.kembalian, metode_bayar: split.metodeFinal }, 201);
  } catch (err: any) {
    // FIX: sebelumnya SEMUA error 'UNIQUE' didiagnosis sebagai offline_uuid
    // collision, padahal tabel transaksi punya 2 kolom UNIQUE (kode_transaksi
    // & offline_uuid) -- pesan error D1/SQLite menyertakan nama kolom
    // spesifik, jadi bisa dibedakan dengan pasti alih-alih ditebak salah.
    const pesanError = String(err?.message ?? '');
    let msg = 'Gagal menyimpan transaksi';
    if (pesanError.includes('offline_uuid')) {
      msg = 'Transaksi dengan offline_uuid ini sudah pernah masuk';
    } else if (pesanError.includes('kode_transaksi')) {
      // Retry di dalam loop di atas sudah habis (MAX_PERCOBAAN_KODE_TRX) --
      // ini kasus sangat jarang (butuh tabrakan acak berturut-turut), kasir
      // tinggal coba lagi karena kode baru akan digenerate dari awal.
      msg = 'Gagal membuat kode transaksi unik, silakan coba lagi';
    }
    return c.json({ success: false, error: msg }, 500);
  }
});

app.get('/api/transaksi', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { tanggal, dari, sampai, kasir_id } = c.req.query();

  // FIX (laporan): LIMIT sebelumnya di-hardcode 500 tanpa cara untuk
  // mengambil lebih banyak — export Excel laporan diam-diam kepotong untuk
  // toko dengan >500 transaksi dalam rentang tanggal, tanpa peringatan sama
  // sekali. Sekarang bisa diminta lebih besar lewat ?limit= (dibatasi 5000
  // supaya tidak jadi query tak terbatas), default tetap 500 untuk tampilan
  // UI biasa.
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 500) || 500, 1), 5000);

  let sql = `
    SELECT t.*, u.nama_lengkap as kasir_nama
    FROM transaksi t
    JOIN users u ON u.id = t.kasir_id
    JOIN toko tk ON tk.id = t.toko_id
    WHERE tk.toko_pusat_id = ?`;
  const params: any[] = [session.toko_pusat_id];

  if (session.role === 'kasir') {
    sql += ' AND t.kasir_id = ?';
    params.push(session.uid);
  } else if (session.role === 'admin_toko') {
    sql += ' AND t.toko_id = ?';
    params.push(session.toko_id);
  } else if (kasir_id) {
    sql += ' AND t.kasir_id = ?';
    params.push(kasir_id);
  }

  if (tanggal) {
    sql += ` AND ${wibDateExpr('t.created_at')} = date(?)`;
    params.push(tanggal);
  }
  if (dari) { sql += ` AND ${wibDateExpr('t.created_at')} >= date(?)`; params.push(dari); }
  if (sampai) { sql += ` AND ${wibDateExpr('t.created_at')} <= date(?)`; params.push(sampai); }

  sql += ' ORDER BY t.created_at DESC LIMIT ' + (limit + 1);

  const { results } = await db.prepare(sql).bind(...params).all<any>();
  // Ambil limit+1 supaya bisa tahu apakah data terpotong (ada baris lebih)
  // tanpa perlu query COUNT(*) terpisah — lalu buang baris ekstranya sebelum dikirim.
  const truncated = results.length > limit;
  const data = truncated ? results.slice(0, limit) : results;
  return c.json({ success: true, data, truncated });
});

app.get('/api/transaksi/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');
  const trx = await db.prepare('SELECT * FROM transaksi WHERE id = ?').bind(id).first<any>();
  if (!trx) return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);

  // FIX (security/IDOR): sebelumnya endpoint ini tidak mengecek kepemilikan
  // sama sekali — user manapun yang login (termasuk kasir) bisa melihat
  // detail transaksi toko/kasir lain hanya dengan menebak ID. Terapkan aturan
  // yang sama seperti GET /api/transaksi (list): kasir hanya transaksinya
  // sendiri, admin_toko hanya tokonya sendiri, super_admin bebas DALAM
  // TENANT-nya (FIX multi-tenant: sebelumnya "bebas" berarti bebas lintas
  // tenant juga, sekarang dikunci ke toko_pusat_id).
  const tokoTrxDetail = await db.prepare('SELECT toko_pusat_id FROM toko WHERE id = ?').bind(trx.toko_id).first<any>();
  if (!tokoTrxDetail || tokoTrxDetail.toko_pusat_id !== session.toko_pusat_id) {
    return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
  }
  if (session.role === 'kasir' && trx.kasir_id !== session.uid) {
    return c.json({ success: false, error: 'Transaksi ini bukan milik Anda' }, 403);
  }
  if (session.role === 'admin_toko' && trx.toko_id !== session.toko_id) {
    return c.json({ success: false, error: 'Transaksi ini bukan milik toko Anda' }, 403);
  }

  const { results: items } = await db
    .prepare('SELECT * FROM detail_transaksi WHERE transaksi_id = ?')
    .bind(id)
    .all();

  const { results: pembayaran } = await db
    .prepare('SELECT metode_bayar, jumlah FROM transaksi_pembayaran WHERE transaksi_id = ?')
    .bind(id)
    .all();

  // Riwayat retur (kalau ada) -- ditampilkan supaya admin lihat item mana
  // yang sudah pernah diretur & berapa sisa yang masih bisa diretur lagi.
  const { results: retur } = await db
    .prepare('SELECT id, total_retur, alasan, created_at FROM retur WHERE transaksi_id = ? ORDER BY created_at DESC')
    .bind(id)
    .all();

  return c.json({ success: true, data: { ...trx, items, pembayaran, retur } });
});

app.post('/api/transaksi/:id/batalkan', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');

  try {
    const trx = await db.prepare('SELECT * FROM transaksi WHERE id = ?').bind(id).first<any>();
    if (!trx) return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    if (trx.status === 'dibatalkan') {
      return c.json({ success: false, error: 'Transaksi sudah dibatalkan sebelumnya' }, 400);
    }

    // FIX (security): admin_toko sebelumnya bisa membatalkan transaksi TOKO
    // LAIN (mengembalikan stok & mengubah laporan keuangan toko lain) karena
    // tidak ada pengecekan kepemilikan toko.
    // FIX (security, multi-tenant): super_admin JUGA sekarang wajib dicek --
    // sebelumnya "bebas akses semua" termasuk transaksi TENANT LAIN.
    const tokoTrx = await db.prepare('SELECT toko_pusat_id FROM toko WHERE id = ?').bind(trx.toko_id).first<any>();
    if (!tokoTrx || tokoTrx.toko_pusat_id !== session.toko_pusat_id) {
      return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    }
    if (session.role === 'admin_toko' && trx.toko_id !== session.toko_id) {
      return c.json({ success: false, error: 'Transaksi ini bukan milik toko Anda' }, 403);
    }

    const { results: items } = await db
      .prepare('SELECT * FROM detail_transaksi WHERE transaksi_id = ?')
      .bind(id)
      .all<any>();

    const statements = [
      db.prepare("UPDATE transaksi SET status = 'dibatalkan' WHERE id = ?").bind(id),
    ];

    for (const item of items) {
      const produk = await db.prepare('SELECT stok FROM produk WHERE id = ?').bind(item.produk_id).first<any>();
      const stokSebelum = produk?.stok ?? 0;
      // FIX (retur): kalau sebagian qty baris ini sudah pernah diretur duluan
      // (lihat POST /api/transaksi/:id/retur), stok bagian itu SUDAH masuk
      // balik ke gudang saat retur terjadi -- kalau dihitung lagi di sini
      // (pakai item.qty penuh) barangnya bakal ke-double-restock. Cuma
      // kembalikan selisih yang BELUM diretur (qty - qty_retur).
      const qtyDikembalikan = item.qty - item.qty_retur;
      const stokSesudah = stokSebelum + qtyDikembalikan;

      statements.push(
        db.prepare(`UPDATE produk SET stok = ?, updated_at = datetime('now') WHERE id = ?`).bind(stokSesudah, item.produk_id)
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
             VALUES (?, 'masuk', ?, ?, ?, ?, ?)`
          )
          .bind(item.produk_id, qtyDikembalikan, stokSebelum, stokSesudah, `Batal ${trx.kode_transaksi}`, session.uid)
      );
    }

    await db.batch(statements);
    await catatLog(
      db,
      session,
      'batalkan',
      'transaksi',
      trx.id,
      `Membatalkan transaksi ${trx.kode_transaksi} (total Rp${Number(trx.total_bayar).toLocaleString('id-ID')})`
    );
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: 'Gagal membatalkan transaksi' }, 500);
  }
});

/**
 * Retur SEBAGIAN item dari sebuah transaksi (berbeda dari /batalkan yang
 * all-or-nothing seluruh transaksi). Body: { items: [{detail_id, qty}],
 * alasan? }. Stok dikembalikan per-item, transaksi.total_bayar dikurangi
 * proporsional, dan detail_transaksi.qty_retur/subtotal_retur di-akumulasi
 * supaya laporan (laba, produk terlaris) otomatis ikut benar tanpa mengubah
 * data transaksi asli (tetap jadi arsip apa yang sebenarnya terjadi).
 */
app.post('/api/transaksi/:id/retur', requireAuth, requireRole('super_admin', 'admin_toko', 'kasir'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const items: any[] = Array.isArray(body.items) ? body.items : [];
  const alasan = typeof body.alasan === 'string' && body.alasan.trim() ? body.alasan.trim().slice(0, 500) : null;

  if (items.length === 0) {
    return c.json({ success: false, error: 'Pilih minimal 1 item untuk diretur' }, 400);
  }

  // WAJIB dipilih eksplisit (bukan default diam-diam) -- ini menentukan
  // apakah kas sistem shift (GET /api/shift/aktif, POST /api/shift/tutup)
  // ikut dikurangi atau tidak. Salah asumsi di sini bikin rekonsiliasi kas
  // kasir meleset, jadi lebih baik kasir/admin diminta pilih sadar daripada
  // sistem menebak.
  const metodePengembalian = body.metode_pengembalian;
  if (metodePengembalian !== 'cash' && metodePengembalian !== 'non_cash') {
    return c.json(
      { success: false, error: "metode_pengembalian wajib diisi: 'cash' (uang tunai keluar dari laci) atau 'non_cash' (transfer balik/kredit, tidak mengurangi kas fisik)" },
      400
    );
  }

  // Kasir boleh proses retur sendiri, tapi wajib konfirmasi ulang PASSWORD
  // MILIKNYA SENDIRI dulu (re-autentikasi identitas, pola umum "sudah yakin
  // ini benar-benar Anda" -- BUKAN persetujuan/pengawasan dari atasan).
  // username tidak perlu diminta lagi karena identitas sudah pasti dari
  // sesi login yang sedang aktif (session.uid). super_admin/admin_toko yang
  // login LANGSUNG (bukan kasir) tidak perlu konfirmasi ini, mereka sudah
  // py otoritas sendiri saat itu juga.
  if (session.role === 'kasir') {
    const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : '';
    if (!confirmPassword) {
      return c.json({ success: false, error: 'Konfirmasi password diperlukan untuk retur' }, 400);
    }
    const diriSendiri = await db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(session.uid).first<any>();
    // Timing-safe: selalu jalankan verifyPassword walau baris user entah
    // kenapa tidak ketemu (harusnya selalu ada karena requireAuth sudah
    // memvalidasi sesi), sama seperti pola di POST /api/auth/login.
    const valid = diriSendiri
      ? await verifyPassword(confirmPassword, diriSendiri.password_hash, diriSendiri.password_salt)
      : await verifyPassword(confirmPassword, '', 'AAAAAAAAAAAAAAAAAAAAAA==');
    if (!diriSendiri || !valid) {
      return c.json({ success: false, error: 'Password salah' }, 403);
    }
  }

  try {
    const trx = await db.prepare('SELECT * FROM transaksi WHERE id = ?').bind(id).first<any>();
    if (!trx) return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    if (trx.status === 'dibatalkan') {
      return c.json({ success: false, error: 'Transaksi ini sudah dibatalkan, tidak bisa diretur lagi' }, 400);
    }
    // FIX (security, multi-tenant): sebelumnya HANYA admin_toko yang dicek --
    // super_admin & kasir sama sekali tidak, artinya bisa retur transaksi
    // toko LAIN (kasir) atau bahkan TENANT LAIN (super_admin) dengan bebas.
    const tokoTrxRetur = await db.prepare('SELECT toko_pusat_id FROM toko WHERE id = ?').bind(trx.toko_id).first<any>();
    if (!tokoTrxRetur || tokoTrxRetur.toko_pusat_id !== session.toko_pusat_id) {
      return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    }
    if (session.role !== 'super_admin' && trx.toko_id !== session.toko_id) {
      return c.json({ success: false, error: 'Transaksi ini bukan milik toko Anda' }, 403);
    }
    // Kasir cuma boleh retur transaksi MILIKNYA SENDIRI -- konsisten dengan
    // pembatasan yang sama di GET /api/transaksi/:id (kasir tidak bisa lihat
    // detail transaksi kasir lain sama sekali, jadi otomatis tidak akan bisa
    // memilih transaksi orang lain lewat UI pun).
    if (session.role === 'kasir' && trx.kasir_id !== session.uid) {
      return c.json({ success: false, error: 'Transaksi ini bukan milik Anda' }, 403);
    }

    const detailIds = items.map((i: any) => Number(i.detail_id));
    if (detailIds.some((x) => !Number.isInteger(x))) {
      return c.json({ success: false, error: 'detail_id tidak valid pada salah satu item' }, 400);
    }
    const placeholders = detailIds.map(() => '?').join(',');
    const { results: detailRows } = await db
      .prepare(`SELECT * FROM detail_transaksi WHERE transaksi_id = ? AND id IN (${placeholders})`)
      .bind(id, ...detailIds)
      .all<any>();
    const detailMap = new Map(detailRows.map((d: any) => [d.id, d]));

    // Validasi semua item DULU sebelum eksekusi apapun (fail-fast) -- supaya
    // kalau ada 1 item tidak valid di tengah daftar, tidak ada perubahan
    // separuh-jalan yang tersimpan. sisaTerpakai melacak akumulasi qty yang
    // sudah "dijatah" ke tiap detail_id DALAM request ini sendiri -- kalau
    // tidak, detail_id yang sama muncul 2x di body bisa lolos validasi
    // walau totalnya sebenarnya melebihi sisa yang boleh diretur.
    let totalRetur = 0;
    const sisaTerpakai = new Map<number, number>();
    const rencana: { detail: any; qtyRetur: number; subtotalReturItem: number }[] = [];
    for (const item of items) {
      const detailId = Number(item.detail_id);
      const qtyRetur = Number(item.qty);
      const detail = detailMap.get(detailId);
      if (!detail) {
        return c.json({ success: false, error: `Item id=${detailId} bukan bagian dari transaksi ini` }, 400);
      }
      if (!Number.isInteger(qtyRetur) || qtyRetur <= 0) {
        return c.json({ success: false, error: `Qty retur tidak valid untuk "${detail.nama_produk}"` }, 400);
      }
      const sudahDipakai = sisaTerpakai.get(detailId) ?? 0;
      const sisaBisaRetur = detail.qty - detail.qty_retur - sudahDipakai;
      if (qtyRetur > sisaBisaRetur) {
        return c.json(
          { success: false, error: `Qty retur "${detail.nama_produk}" melebihi sisa yang bisa diretur (maks ${sisaBisaRetur})` },
          400
        );
      }
      sisaTerpakai.set(detailId, sudahDipakai + qtyRetur);
      // Subtotal per unit dari subtotal baris ASLI (sudah net diskon item),
      // bukan harga_satuan mentah -- supaya proporsional dengan diskon yang
      // sudah diterapkan saat transaksi.
      const subtotalPerUnit = detail.subtotal / detail.qty;
      const subtotalReturItem = Math.round(subtotalPerUnit * qtyRetur);
      totalRetur += subtotalReturItem;
      rencana.push({ detail, qtyRetur, subtotalReturItem });
    }

    const statements: any[] = [];
    for (const { detail, qtyRetur, subtotalReturItem } of rencana) {
      statements.push(
        db
          .prepare('UPDATE detail_transaksi SET qty_retur = qty_retur + ?, subtotal_retur = subtotal_retur + ? WHERE id = ?')
          .bind(qtyRetur, subtotalReturItem, detail.id)
      );

      // FIX: update stok pakai increment RELATIF ("stok = stok + ?"), bukan
      // baca-lalu-tulis nilai absolut -- kalau produk_id yang sama muncul di
      // lebih dari satu baris rencana (mis. detail_id yang sama disubmit 2x
      // dalam satu request, sudah divalidasi valid oleh sisaTerpakai di atas),
      // versi "baca dulu" akan lost-update (SELECT kedua masih baca nilai
      // lama karena UPDATE pertama belum benar-benar jalan, baru antre di
      // batch) -- incremental SQL aman dari race semacam ini karena SQLite
      // mengevaluasi "stok + ?" terhadap nilai TERBARU saat statement itu
      // benar-benar dieksekusi di dalam batch, bukan snapshot di awal.
      statements.push(
        db.prepare(`UPDATE produk SET stok = stok + ?, updated_at = datetime('now') WHERE id = ?`).bind(qtyRetur, detail.produk_id)
      );

      const produk = await db.prepare('SELECT stok FROM produk WHERE id = ?').bind(detail.produk_id).first<any>();
      const stokSebelum = produk?.stok ?? 0; // hanya untuk snapshot audit riwayat_stok, BUKAN sumber kebenaran stok final
      statements.push(
        db
          .prepare(
            `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
             VALUES (?, 'masuk', ?, ?, ?, ?, ?)`
          )
          .bind(detail.produk_id, qtyRetur, stokSebelum, stokSebelum + qtyRetur, `Retur ${trx.kode_transaksi}`, session.uid)
      );
    }
    statements.push(db.prepare('UPDATE transaksi SET total_bayar = total_bayar - ? WHERE id = ?').bind(totalRetur, id));
    statements.push(
      db
        .prepare('INSERT INTO retur (transaksi_id, toko_id, user_id, total_retur, alasan, metode_pengembalian) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, trx.toko_id, session.uid, totalRetur, alasan, metodePengembalian)
    );
    await db.batch(statements);

    // db.batch() D1 tidak mengembalikan insertId per-statement dengan jelas,
    // jadi query ulang baris retur yang baru saja dibuat untuk insert
    // retur_item-nya (aman: satu transaksi HTTP request = satu retur baru,
    // tidak ada race antar-request lain yang bisa nyelip di antaranya karena
    // ini masih dalam alur sinkron sebelum response dikirim).
    const returBaru = await db.prepare('SELECT id FROM retur WHERE transaksi_id = ? ORDER BY id DESC LIMIT 1').bind(id).first<any>();
    await db.batch(
      rencana.map(({ detail, qtyRetur, subtotalReturItem }) =>
        db
          .prepare(
            `INSERT INTO retur_item (retur_id, detail_transaksi_id, produk_id, nama_produk, qty, subtotal)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(returBaru.id, detail.id, detail.produk_id, detail.nama_produk, qtyRetur, subtotalReturItem)
      )
    );

    await catatLog(
      db,
      session,
      'retur',
      'transaksi',
      trx.id,
      `Retur ${rencana.length} item dari transaksi ${trx.kode_transaksi} (Rp${totalRetur.toLocaleString('id-ID')})${alasan ? ` — ${alasan}` : ''}${session.role === 'kasir' ? ' — konfirmasi password kasir' : ''}`
    );

    return c.json({ success: true, total_retur: totalRetur });
  } catch (err: any) {
    console.error('Gagal retur:', err);
    return c.json({ success: false, error: 'Gagal memproses retur' }, 500);
  }
});

// ==========================================================
// 6. ROUTES: LAPORAN
// ==========================================================

app.get('/api/laporan/harian', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const tanggal = c.req.query('tanggal') ?? todayWIB();

  let sql = `
    SELECT COUNT(*) as jumlah_transaksi, COALESCE(SUM(total_bayar), 0) as total_penjualan
    FROM transaksi t WHERE ${wibDateExpr('t.created_at')} = date(?) AND t.status = 'selesai'`;
  const params: any[] = [tanggal];

  if (session.role !== 'super_admin') {
    sql += ' AND t.toko_id = ?';
    params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: { jumlah_transaksi: 0, total_penjualan: 0 } });
    sql += ` AND t.toko_id IN (${tokoIds.map(() => '?').join(',')})`;
    params.push(...tokoIds);
  }

  const row = await db.prepare(sql).bind(...params).first();
  return c.json({ success: true, data: row });
});

app.get('/api/laporan/produk-terlaris', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { dari, sampai, limit = '10' } = c.req.query();

  let sql = `
    SELECT dt.produk_id, dt.nama_produk,
           SUM(dt.qty - dt.qty_retur) as total_qty,
           SUM(dt.subtotal - dt.subtotal_retur) as total_omzet
    FROM detail_transaksi dt
    JOIN transaksi t ON t.id = dt.transaksi_id
    WHERE t.status = 'selesai'`;
  const params: any[] = [];

  if (dari) { sql += ` AND ${wibDateExpr('t.created_at')} >= date(?)`; params.push(dari); }
  if (sampai) { sql += ` AND ${wibDateExpr('t.created_at')} <= date(?)`; params.push(sampai); }
  if (session.role !== 'super_admin') {
    sql += ' AND t.toko_id = ?';
    params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: [] });
    sql += ` AND t.toko_id IN (${tokoIds.map(() => '?').join(',')})`;
    params.push(...tokoIds);
  }

  sql += ' GROUP BY dt.produk_id ORDER BY total_qty DESC LIMIT ?';
  params.push(Number(limit));

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

/**
 * Laporan Laba (laba kotor) — omzet dikurangi HPP (harga pokok penjualan).
 * HPP dihitung dari kolom hpp_satuan yang di-snapshot per baris detail_transaksi
 * saat transaksi terjadi (lihat migrasi 0006 & POST /api/transaksi), BUKAN dari
 * harga_beli produk saat ini — supaya laba transaksi lampau tidak berubah kalau
 * harga beli produk berubah setelahnya. Transaksi yang dibatalkan (status !=
 * 'selesai') tidak dihitung, konsisten dengan laporan lain. qty_retur/
 * subtotal_retur (migrasi 0009) juga dikurangkan supaya item yang diretur
 * sebagian tidak ikut dihitung sebagai omzet/laba.
 */
app.get('/api/laporan/laba', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { dari, sampai } = c.req.query();

  let sql = `
    SELECT dt.produk_id, dt.nama_produk,
           SUM(dt.qty - dt.qty_retur) as total_qty,
           SUM(dt.subtotal - dt.subtotal_retur) as omzet,
           SUM(dt.hpp_satuan * (dt.qty - dt.qty_retur)) as hpp,
           SUM((dt.subtotal - dt.subtotal_retur) - (dt.hpp_satuan * (dt.qty - dt.qty_retur))) as laba_kotor
    FROM detail_transaksi dt
    JOIN transaksi t ON t.id = dt.transaksi_id
    WHERE t.status = 'selesai'`;
  const params: any[] = [];

  if (dari) { sql += ` AND ${wibDateExpr('t.created_at')} >= date(?)`; params.push(dari); }
  if (sampai) { sql += ` AND ${wibDateExpr('t.created_at')} <= date(?)`; params.push(sampai); }
  if (session.role !== 'super_admin') {
    sql += ' AND t.toko_id = ?';
    params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: { ringkasan: { omzet: 0, hpp: 0, laba_kotor: 0, margin_persen: 0 }, produk: [] } });
    sql += ` AND t.toko_id IN (${tokoIds.map(() => '?').join(',')})`;
    params.push(...tokoIds);
  }

  sql += ' GROUP BY dt.produk_id ORDER BY laba_kotor DESC';

  const { results } = await db.prepare(sql).bind(...params).all<any>();

  const ringkasan = results.reduce(
    (acc: any, r: any) => {
      acc.omzet += r.omzet || 0;
      acc.hpp += r.hpp || 0;
      acc.laba_kotor += r.laba_kotor || 0;
      return acc;
    },
    { omzet: 0, hpp: 0, laba_kotor: 0 }
  );
  (ringkasan as any).margin_persen = ringkasan.omzet > 0 ? Math.round((ringkasan.laba_kotor / ringkasan.omzet) * 1000) / 10 : 0;

  return c.json({ success: true, data: { ringkasan, produk: results } });
});

/**
 * Tren penjualan harian dalam rentang N hari terakhir (default 7) — dipakai
 * untuk grafik di dashboard admin. Mengembalikan SEMUA tanggal dalam rentang
 * (termasuk yang omzetnya 0) supaya sumbu-X chart tidak bolong/loncat.
 */
app.get('/api/laporan/tren-penjualan', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const hari = Math.min(Math.max(Number(c.req.query('hari') ?? 7), 1), 90);

  let sql = `
    SELECT ${wibDateExpr('created_at')} as tanggal, COUNT(*) as jumlah_transaksi, COALESCE(SUM(total_bayar), 0) as total_penjualan
    FROM transaksi
    WHERE status = 'selesai' AND ${wibDateExpr('created_at')} >= date(?, ?)`;
  const params: any[] = [todayWIB(), `-${hari - 1} days`];

  if (session.role !== 'super_admin') {
    sql += ' AND toko_id = ?';
    params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length > 0) {
      sql += ` AND toko_id IN (${tokoIds.map(() => '?').join(',')})`;
      params.push(...tokoIds);
    } else {
      sql += ' AND 0=1'; // tenant belum punya cabang -> hasil kosong
    }
  }
  sql += ` GROUP BY ${wibDateExpr('created_at')} ORDER BY tanggal ASC`;

  const { results } = await db.prepare(sql).bind(...params).all<any>();
  const dataMap = new Map(results.map((r: any) => [r.tanggal, r]));

  // Isi tanggal kosong dengan 0 supaya grafik tetap kontinu. Dihitung mundur
  // dari "hari ini" versi WIB, bukan UTC, supaya konsisten dengan query di atas.
  const lengkap: { tanggal: string; jumlah_transaksi: number; total_penjualan: number }[] = [];
  const hariIniWIB = new Date(Date.now() + 7 * 60 * 60 * 1000);
  for (let i = hari - 1; i >= 0; i--) {
    const d = new Date(hariIniWIB);
    d.setUTCDate(d.getUTCDate() - i);
    const tgl = d.toISOString().slice(0, 10);
    const row = dataMap.get(tgl) as any;
    lengkap.push({
      tanggal: tgl,
      jumlah_transaksi: row?.jumlah_transaksi ?? 0,
      total_penjualan: row?.total_penjualan ?? 0,
    });
  }

  return c.json({ success: true, data: lengkap });
});

app.get('/api/laporan/stok-menipis', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const ambang = Number(c.req.query('ambang') ?? 10);

  let sql = 'SELECT * FROM produk WHERE is_active = 1 AND stok <= ?';
  const params: any[] = [ambang];

  if (session.role !== 'super_admin') {
    sql += ' AND toko_id = ?';
    params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: [] });
    sql += ` AND toko_id IN (${tokoIds.map(() => '?').join(',')})`;
    params.push(...tokoIds);
  }
  sql += ' ORDER BY stok ASC';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// ==========================================================
// 7. ROUTES: USERS (admin only)
// ==========================================================

app.get('/api/users', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  // shift_aktif: 1 kalau user ini punya baris shift_kasir berstatus 'buka' saat
  // ini, 0 kalau tidak — supaya admin bisa lihat siapa sedang kerja langsung
  // dari daftar user, tanpa perlu buka menu Shift terpisah. Subquery (bukan
  // JOIN) sengaja dipakai supaya user tanpa shift sama sekali tetap muncul
  // (JOIN biasa akan menyaring baris yang tidak match).
  let sql = `
    SELECT u.id, u.username, u.nama_lengkap, u.role, u.toko_id, u.is_active,
           EXISTS(SELECT 1 FROM shift_kasir sk WHERE sk.kasir_id = u.id AND sk.status = 'buka') as shift_aktif
    FROM users u WHERE u.toko_pusat_id = ?`;
  const params: any[] = [session.toko_pusat_id];
  if (session.role === 'admin_toko') {
    sql += " AND u.toko_id = ? AND u.role = 'kasir'";
    params.push(session.toko_id);
  }
  sql += ' ORDER BY u.nama_lengkap ASC';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

app.post('/api/users', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<any>();

    if (!body.username || !body.password || !body.nama_lengkap) {
      return c.json({ success: false, error: 'username, password, dan nama_lengkap wajib diisi' }, 400);
    }
    // FIX: aturan "minimal 6 karakter" sebelumnya cuma dicek di JS admin.html
    // (gampang dilewati lewat panggilan API langsung) — endpoint self-service
    // /api/auth/change-password sudah benar mengecek ini di server, tapi
    // pembuatan user oleh admin belum. Samakan aturannya di sini.
    if (String(body.password).length < 6) {
      return c.json({ success: false, error: 'Password minimal 6 karakter' }, 400);
    }
    // admin_toko hanya boleh membuat kasir di tokonya sendiri; super_admin
    // WAJIB pilih toko_id yang divalidasi milik tenant-nya sendiri (jangan
    // percaya body.toko_id mentah -- bisa dipakai bikin user "menyusup" ke
    // tenant lain).
    const role = session.role === 'admin_toko' ? 'kasir' : body.role ?? 'kasir';
    const toko_id = session.role === 'admin_toko' ? session.toko_id : await validasiTokoIdMilikTenant(db, session, body.toko_id);
    if (role !== 'super_admin' && !toko_id) {
      return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid untuk role ini' }, 400);
    }

    const { hash, salt } = await hashPassword(body.password);

    const result = await db
      .prepare(
        `INSERT INTO users (username, password_hash, password_salt, nama_lengkap, role, toko_pusat_id, toko_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(body.username, hash, salt, body.nama_lengkap, role, session.toko_pusat_id, toko_id ?? null)
      .run();

    await catatLog(
      db,
      session,
      'tambah',
      'user',
      result.meta.last_row_id,
      `Menambah user "${body.username}" (${body.nama_lengkap}), role ${role}`
    );

    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (err: any) {
    const msg = String(err.message ?? '').includes('UNIQUE') ? 'Username sudah dipakai' : 'Gagal menambah user';
    return c.json({ success: false, error: msg }, 400);
  }
});

app.put('/api/users/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const body = await c.req.json<any>();

    const userLama = await db.prepare('SELECT username, nama_lengkap, role, toko_pusat_id, toko_id, is_active FROM users WHERE id = ?').bind(id).first<any>();
    if (!userLama) return c.json({ success: false, error: 'User tidak ditemukan' }, 404);

    // FIX (security): super_admin HANYA boleh ubah user DALAM TENANT-nya
    // sendiri (toko_pusat_id) -- sebelumnya endpoint ini tidak mengecek ini
    // sama sekali, super_admin tenant A bisa reset password / nonaktifkan
    // akun siapa pun di TENANT LAIN (privilege escalation lintas-tenant).
    if (session.role === 'super_admin' && userLama.toko_pusat_id !== session.toko_pusat_id) {
      return c.json({ success: false, error: 'User tidak ditemukan' }, 404);
    }

    // FIX (security): admin_toko HANYA boleh mengubah akun kasir di tokonya
    // sendiri — sebelumnya endpoint ini tidak mengecek kepemilikan toko sama
    // sekali, jadi admin_toko manapun bisa reset password / menonaktifkan
    // AKUN SIAPA PUN di seluruh sistem (termasuk super_admin/admin_toko toko
    // lain), yang berarti privilege escalation penuh. Konsisten dengan batas
    // yang sudah berlaku di POST /api/users (admin_toko hanya bisa membuat
    // kasir di tokonya sendiri).
    if (session.role === 'admin_toko' && (userLama.role !== 'kasir' || userLama.toko_id !== session.toko_id)) {
      return c.json({ success: false, error: 'Anda tidak memiliki akses untuk mengubah user ini' }, 403);
    }

    const finalIsActive = body.is_active === undefined || body.is_active === null ? 1 : Number(body.is_active) ? 1 : 0;

    // Proteksi: endpoint ini tidak bisa mengubah role (lihat query di bawah),
    // tapi BISA menonaktifkan akun. Kalau target adalah super_admin dan
    // hasilnya akan dinonaktifkan, pastikan masih ada super_admin aktif LAIN
    // yang tersisa — supaya panel admin tidak pernah terkunci total (tidak
    // ada satu pun yang bisa login sebagai super_admin untuk memperbaikinya).
    if (userLama.role === 'super_admin' && finalIsActive === 0) {
      const { c: jumlahSuperAdminLain } = (await db
        .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'super_admin' AND is_active = 1 AND toko_pusat_id = ? AND id != ?")
        .bind(userLama.toko_pusat_id, id)
        .first<any>()) ?? { c: 0 };
      if (jumlahSuperAdminLain === 0) {
        return c.json(
          { success: false, error: 'Tidak bisa menonaktifkan super_admin ini — minimal harus ada 1 super_admin aktif tersisa.' },
          400
        );
      }
    }

    if (body.password) {
      // FIX: sama seperti POST /api/users — aturan "minimal 6 karakter"
      // sebelumnya cuma dicek di JS admin.html, tidak sama sekali di server.
      if (String(body.password).length < 6) {
        return c.json({ success: false, error: 'Password minimal 6 karakter' }, 400);
      }
      const { hash, salt } = await hashPassword(body.password);
      await db
        .prepare('UPDATE users SET nama_lengkap = ?, is_active = ?, password_hash = ?, password_salt = ? WHERE id = ?')
        .bind(body.nama_lengkap, finalIsActive, hash, salt, id)
        .run();
    } else {
      await db
        .prepare('UPDATE users SET nama_lengkap = ?, is_active = ? WHERE id = ?')
        .bind(body.nama_lengkap, finalIsActive, id)
        .run();
    }

    // Log spesifik: status aktif/nonaktif berubah dan/atau password direset —
    // dua hal ini paling sensitif untuk diaudit dibanding sekadar ganti nama.
    const catatan: string[] = [];
    if (Number(userLama.is_active) !== finalIsActive) {
      catatan.push(finalIsActive ? 'mengaktifkan kembali akun' : 'menonaktifkan akun');
    }
    if (body.password) catatan.push('reset password');
    if (catatan.length === 0) catatan.push('ubah data profil');

    await catatLog(
      db,
      session,
      catatan.some((x) => x.includes('nonaktifkan')) ? 'nonaktifkan' : 'ubah',
      'user',
      id,
      `User "${userLama.username}": ${catatan.join(', ')}`
    );

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: 'Gagal mengubah user' }, 400);
  }
});

// ==========================================================
// 7b. ROUTES: LOG AKTIVITAS (audit trail admin)
// ==========================================================

/**
 * Riwayat aksi admin (tambah/ubah/nonaktifkan produk & user, batalkan transaksi,
 * dll). admin_toko hanya lihat log tokonya sendiri; super_admin lihat semua
 * (opsional filter ?toko_id=). Ini terpisah dari riwayat_stok yang khusus
 * mutasi stok.
 */
app.get('/api/log-aktivitas', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { entitas, dari, sampai } = c.req.query();

  let sql = 'SELECT * FROM log_aktivitas WHERE 1=1';
  const params: any[] = [];

  if (session.role !== 'super_admin') {
    sql += ' AND toko_id = ?';
    params.push(session.toko_id);
  } else {
    const tokoIdFilter = c.req.query('toko_id');
    if (tokoIdFilter) {
      const valid = await validasiTokoIdMilikTenant(db, session, tokoIdFilter);
      if (!valid) return c.json({ success: false, error: 'toko_id tidak valid' }, 400);
      sql += ' AND toko_id = ?';
      params.push(valid);
    } else {
      const tokoIdsTenant = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
      if (tokoIdsTenant.length === 0) return c.json({ success: true, data: [] });
      sql += ` AND toko_id IN (${tokoIdsTenant.map(() => '?').join(',')})`;
      params.push(...tokoIdsTenant);
    }
  }
  if (entitas) { sql += ' AND entitas = ?'; params.push(entitas); }
  if (dari) { sql += ' AND date(created_at) >= date(?)'; params.push(dari); }
  if (sampai) { sql += ' AND date(created_at) <= date(?)'; params.push(sampai); }

  sql += ' ORDER BY created_at DESC LIMIT 300';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// ==========================================================
// 7b. RESET DATA TOKO (destruktif — hapus produk, transaksi, shift,
//     riwayat stok, & log lama satu toko; user & data toko tetap ada)
// ==========================================================
app.post('/api/admin/reset-data', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const body = await c.req.json().catch(() => ({}));

  // super_admin WAJIB pilih toko_id eksplisit (bisa kelola banyak toko,
  // toko_id session-nya sendiri biasanya null) -- admin_toko selalu dipaksa
  // ke toko_id miliknya sendiri sendiri, tidak bisa reset toko lain lewat body.
  // toko_id WAJIB divalidasi milik toko_pusat_id (tenant) sesi ini -- endpoint
  // ini DESTRUKTIF, tanpa validasi ini super_admin tenant A bisa hapus total
  // data tenant B cuma dengan tebak/tau toko_id-nya.
  const targetTokoId =
    session.role === 'super_admin' ? await validasiTokoIdMilikTenant(db, session, body.toko_id) : session.toko_id;
  if (!targetTokoId) {
    return c.json({ success: false, error: 'toko_id tujuan tidak valid' }, 400);
  }

  // Pengaman: harus ketik ulang frasa persis, mencegah klik tidak sengaja
  // ATAU pemanggilan endpoint ini secara tidak sengaja dari bug lain.
  if (body.konfirmasi !== 'HAPUS SEMUA DATA') {
    return c.json({ success: false, error: 'Frasa konfirmasi tidak sesuai. Ketik persis: HAPUS SEMUA DATA' }, 400);
  }

  const toko = await db.prepare('SELECT id, nama FROM toko WHERE id = ?').bind(targetTokoId).first<any>();
  if (!toko) return c.json({ success: false, error: 'Toko tidak ditemukan' }, 404);

  try {
    // Urutan HARUS begini (anak sebelum induk) karena foreign key —
    // dibungkus db.batch() supaya atomik (semua sukses atau semua batal).
    //
    // FIX (bug kritis): retur_item & retur WAJIB dihapus sebelum
    // detail_transaksi & transaksi — keduanya tidak punya ON DELETE CASCADE,
    // jadi DELETE transaksi/detail_transaksi sebelumnya selalu GAGAL dengan
    // FK violation kalau toko ini punya data retur.
    // Urutan lengkap:
    //   retur_item → retur → detail_transaksi + transaksi_pembayaran
    //   → riwayat_stok → transaksi → shift_kasir → log_aktivitas → produk
    // (produk dihapus paling akhir karena riwayat_stok & produk_galeri
    //  reference ke sana; produk_galeri punya ON DELETE CASCADE, produk di
    //  order_items punya ON DELETE SET NULL — keduanya aman tanpa hapus manual)
    await db.batch([
      db.prepare('DELETE FROM retur_item WHERE retur_id IN (SELECT id FROM retur WHERE toko_id = ?)').bind(targetTokoId),
      db.prepare('DELETE FROM retur WHERE toko_id = ?').bind(targetTokoId),
      db.prepare('DELETE FROM detail_transaksi WHERE transaksi_id IN (SELECT id FROM transaksi WHERE toko_id = ?)').bind(targetTokoId),
      db.prepare('DELETE FROM transaksi_pembayaran WHERE transaksi_id IN (SELECT id FROM transaksi WHERE toko_id = ?)').bind(targetTokoId),
      db.prepare('DELETE FROM riwayat_stok WHERE produk_id IN (SELECT id FROM produk WHERE toko_id = ?)').bind(targetTokoId),
      db.prepare('DELETE FROM transaksi WHERE toko_id = ?').bind(targetTokoId),
      db.prepare('DELETE FROM shift_kasir WHERE toko_id = ?').bind(targetTokoId),
      db.prepare('DELETE FROM log_aktivitas WHERE toko_id = ?').bind(targetTokoId),
      db.prepare('DELETE FROM produk WHERE toko_id = ?').bind(targetTokoId),
    ]);

    // Catat SATU entri log baru setelah reset selesai (log lama toko ini
    // baru saja dihapus di atas) -- supaya tetap ada jejak audit siapa &
    // kapan reset ini dilakukan, tidak menghilang tanpa bekas.
    await catatLog(db, session, 'reset', 'toko', targetTokoId, `Reset data toko "${toko.nama}" (semua produk, transaksi, shift, riwayat stok dihapus)`);

    return c.json({ success: true, message: `Data toko "${toko.nama}" berhasil direset` });
  } catch (err: any) {
    console.error('Gagal reset data toko:', err);
    return c.json({ success: false, error: 'Gagal reset data: ' + (err?.message ?? 'unknown error') }, 500);
  }
});

// ==========================================================
// 8. FALLBACK
// ==========================================================

app.notFound((c) => c.json({ success: false, error: 'Endpoint tidak ditemukan' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ success: false, error: 'Kesalahan server internal' }, 500);
});

// ==========================================================
// 9. MOUNT DI PATH "/kasir" (1 domain bersama dengan etalase)
// ==========================================================
// kasire sekarang hidup di https://domainanda.com/kasir/* — BUKAN di
// domain sendiri. Karena `app` di atas didefinisikan dengan route absolut
// tanpa prefix (mis. '/api/produk', bukan '/kasir/api/produk'), request
// yang masuk ke Worker ini (yang selalu berupa /kasir/... berkat
// `routes` + `run_worker_first` di wrangler.toml) HARUS dibuang dulu
// prefix "/kasir"-nya sebelum diteruskan ke `app`.
//
// File statis (HTML/CSS/JS/ikon) juga perlu penanganan sama — makanya
// `run_worker_first` diaktifkan untuk /kasir/* (lihat wrangler.toml),
// supaya Worker ini SELALU jalan duluan (bukan langsung dijawab edge),
// baru dari sini kita panggil `env.ASSETS.fetch()` dengan path yang
// sudah dibuang prefix-nya.
//
// CATATAN: akses langsung ke *.workers.dev (tanpa prefix /kasir, mis.
// saat testing) tetap didukung — kalau prefix "/kasir" tidak ada di
// path, request diteruskan apa adanya (perilaku lama, tidak berubah).
const BASE_PATH = '/kasir';

function tanpaPrefixKasir(url: URL): URL {
  const stripped = new URL(url.toString());
  if (stripped.pathname === BASE_PATH) {
    stripped.pathname = '/';
  } else if (stripped.pathname.startsWith(BASE_PATH + '/')) {
    stripped.pathname = stripped.pathname.slice(BASE_PATH.length) || '/';
  }
  return stripped;
}

export default {
  async fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const dipasangDiKasir = url.pathname === BASE_PATH || url.pathname.startsWith(BASE_PATH + '/');

    // "/kasir" atau "/kasir/" (tanpa halaman spesifik) -> redirect ke
    // login. Ditangani di sini (bukan lewat app.get('/', ...)) karena di
    // sinilah kita tahu persis prefix mount-nya, jadi Location header
    // yang dikirim ke browser pasti benar ("/kasir/login.html").
    if (dipasangDiKasir && (url.pathname === BASE_PATH || url.pathname === BASE_PATH + '/')) {
      return Response.redirect(`${url.origin}${BASE_PATH}/login.html`, 302);
    }
    if (!dipasangDiKasir && url.pathname === '/') {
      return Response.redirect(`${url.origin}/login.html`, 302);
    }

    const urlBersih = dipasangDiKasir ? tanpaPrefixKasir(url) : url;
    const requestBersih = dipasangDiKasir
      ? new Request(urlBersih.toString(), request)
      : request;

    // /api/* -> logika Hono (`app`). Selain itu -> file statis dari ASSETS.
    if (urlBersih.pathname.startsWith('/api/')) {
      return app.fetch(requestBersih, env, ctx);
    }
    return env.ASSETS.fetch(requestBersih);
  },
};
