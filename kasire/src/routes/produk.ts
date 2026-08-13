import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth-middleware';
import type { AppEnv } from '../lib/types';
import { PRODUK_MAX_TOTAL, GAMBAR_MIME_VALID, GAMBAR_MAX_BYTES } from '../lib/types';
import {
  validasiHargaStok,
  getProdukAtauTolak,
  getTokoIdsUntukSesi,
  getTokoIdsUntukTenant,
  validasiTokoIdMilikTenant,
  catatLog,
  cekKuotaR2,
  r2KeyDariGambarUrl,
} from '../lib/helpers';

const produk = new Hono<AppEnv>();

// ==========================================================
// LIST PRODUK
// ==========================================================

produk.get('/', requireAuth, async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const { kategori_id, search } = c.req.query();

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

    const params: any[] = [...tokoIdList];
    let sql = `SELECT p.*, k.nama as kategori_nama
               FROM produk p LEFT JOIN kategori k ON k.id = p.kategori_id
               WHERE p.is_active = 1
               AND p.toko_id IN (${tokoIdList.map(() => '?').join(',')})`;

    if (kategori_id) { sql += ' AND p.kategori_id = ?'; params.push(kategori_id); }
    if (search) {
      sql += ' AND (p.nama LIKE ? OR p.kode_produk LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY p.nama ASC';

    const { results } = await db.prepare(sql).bind(...params).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: false, error: 'Gagal mengambil data produk' }, 500);
  }
});

// ==========================================================
// BUAT PRODUK BARU
// ==========================================================

produk.post('/', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const body = await c.req.json<any>();

    const toko_id =
      session.role === 'super_admin'
        ? await validasiTokoIdMilikTenant(db, session, body.toko_id)
        : session.toko_id;
    if (!toko_id) return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid' }, 400);

    if (!body.kode_produk || !body.nama || body.harga_jual == null) {
      return c.json({ success: false, error: 'kode_produk, nama, dan harga_jual wajib diisi' }, 400);
    }
    const validasi = validasiHargaStok(body);
    if (!validasi.ok) return c.json({ success: false, error: validasi.error }, 400);

    // Cek batas 200 produk aktif per tenant
    const tokoIdsTenant = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    const placeholders = tokoIdsTenant.map(() => '?').join(',');
    const jumlah = await db
      .prepare(`SELECT COUNT(*) as total FROM produk WHERE is_active = 1 AND toko_id IN (${placeholders})`)
      .bind(...tokoIdsTenant)
      .first<{ total: number }>();
    if ((jumlah?.total ?? 0) >= PRODUK_MAX_TOTAL) {
      return c.json({ success: false, error: 'Batas maksimal 200 produk sudah tercapai. Upgrade langganan untuk menambah kuota.' }, 403);
    }

    const result = await db
      .prepare(
        `INSERT INTO produk
           (toko_id, kategori_id, kode_produk, nama, harga_beli, harga_jual, stok, satuan, gambar_url,
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
      db, session, 'tambah', 'produk', result.meta.last_row_id,
      `Menambah produk "${body.nama}" (${body.kode_produk}), harga jual ${body.harga_jual}`
    );
    return c.json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (err: any) {
    const pesan = String(err.message ?? '');
    // idx_produk_slug_per_toko = index baru (per toko_id) sejak migration 0003
    const msg = pesan.includes('idx_produk_slug')
      ? 'Slug etalase sudah dipakai produk lain di toko ini, ganti slug-nya'
      : pesan.includes('UNIQUE') ? 'Kode produk/barcode sudah dipakai' : 'Gagal menambah produk';
    return c.json({ success: false, error: msg }, 400);
  }
});

// ==========================================================
// EDIT PRODUK
// ==========================================================

produk.put('/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const body = await c.req.json<any>();

    if (body.harga_jual == null) return c.json({ success: false, error: 'harga_jual wajib diisi' }, 400);
    const validasi = validasiHargaStok(body);
    if (!validasi.ok) return c.json({ success: false, error: validasi.error }, 400);

    const check = await getProdukAtauTolak(db, id, session);
    if ('error' in check) return check.error;
    const produkLama = check.produk;

    await db
      .prepare(
        `UPDATE produk SET nama=?, kategori_id=?, harga_beli=?, harga_jual=?, satuan=?,
         gambar_url=?, slug=?, deskripsi_toko=?, harga_coret=?, tampil_online=?,
         updated_at=datetime('now') WHERE id=?`
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

    // Hapus foto lama dari R2 kalau diganti
    const keyLama = r2KeyDariGambarUrl(produkLama.gambar_url);
    if (keyLama && produkLama.gambar_url !== body.gambar_url) {
      c.executionCtx.waitUntil(c.env.IMAGES.delete(keyLama).catch(() => {}));
    }

    const perubahan: string[] = [];
    if (produkLama.nama !== body.nama) perubahan.push(`nama: "${produkLama.nama}" → "${body.nama}"`);
    if (Number(produkLama.harga_jual) !== Number(body.harga_jual)) {
      perubahan.push(`harga jual: Rp${Number(produkLama.harga_jual).toLocaleString('id-ID')} → Rp${Number(body.harga_jual).toLocaleString('id-ID')}`);
    }
    if (Number(produkLama.harga_beli ?? 0) !== Number(body.harga_beli ?? 0)) {
      perubahan.push(`harga beli: Rp${Number(produkLama.harga_beli ?? 0).toLocaleString('id-ID')} → Rp${Number(body.harga_beli ?? 0).toLocaleString('id-ID')}`);
    }
    await catatLog(
      db, session, 'ubah', 'produk', id,
      perubahan.length > 0
        ? `Ubah produk "${produkLama.nama}": ${perubahan.join('; ')}`
        : `Ubah produk "${produkLama.nama}" (tanpa perubahan harga/nama)`
    );
    return c.json({ success: true });
  } catch (err: any) {
    // idx_produk_slug_per_toko = index baru (per toko_id) sejak migration 0003
    const msg = String(err.message ?? '').includes('idx_produk_slug')
      ? 'Slug etalase sudah dipakai produk lain di toko ini, ganti slug-nya'
      : 'Gagal mengubah produk';
    return c.json({ success: false, error: msg }, 400);
  }
});

// ==========================================================
// NONAKTIFKAN PRODUK (soft delete)
// ==========================================================

produk.delete('/:id', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');

  const check = await getProdukAtauTolak(db, id, session);
  if ('error' in check) return check.error;

  await db.prepare('UPDATE produk SET is_active = 0 WHERE id = ?').bind(id).run();
  await catatLog(db, session, 'nonaktifkan', 'produk', id, `Menonaktifkan produk "${check.produk.nama}"`);
  return c.json({ success: true });
});

// ==========================================================
// KOREKSI STOK MANUAL
// ==========================================================

produk.post('/:id/koreksi-stok', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = Number(c.req.param('id'));
    const { jumlah, alasan } = await c.req.json<{ jumlah: number; alasan?: string }>();

    if (!Number.isInteger(jumlah) || jumlah === 0) {
      return c.json({ success: false, error: 'jumlah wajib berupa bilangan bulat bukan nol' }, 400);
    }

    const check = await getProdukAtauTolak(db, id, session);
    if ('error' in check) return check.error;
    const stokSebelum = check.produk.stok as number;
    const stokSesudah = stokSebelum + jumlah;

    // FIX: koreksi stok pengurangan bisa hasilkan stok negatif tanpa batas.
    // Stok negatif tidak bermakna secara bisnis dan menyebabkan laporan kacau.
    // Izinkan minimum stok = 0 (habis), tidak boleh lebih rendah dari itu.
    if (stokSesudah < 0) {
      return c.json({
        success: false,
        error: `Stok tidak cukup. Stok saat ini ${stokSebelum}, pengurangan maksimal ${stokSebelum}`
      }, 400);
    }

    await db.batch([
      db.prepare(`UPDATE produk SET stok=?, updated_at=datetime('now') WHERE id=?`).bind(stokSesudah, id),
      db.prepare(
        `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
         VALUES (?, 'koreksi', ?, ?, ?, ?, ?)`
      ).bind(id, jumlah, stokSebelum, stokSesudah, alasan ?? 'Koreksi manual', session.uid),
    ]);

    return c.json({ success: true, stok_sesudah: stokSesudah });
  } catch {
    return c.json({ success: false, error: 'Gagal melakukan koreksi stok' }, 500);
  }
});

// ==========================================================
// RIWAYAT STOK PER PRODUK
// ==========================================================

produk.get('/:id/riwayat-stok', requireAuth, async (c) => {
  try {
    const db = c.env.DB;
    const session = c.get('session');
    const id = c.req.param('id');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);

    const check = await getProdukAtauTolak(db, id, session);
    if ('error' in check) return check.error;

    const { results } = await db
      .prepare(
        `SELECT rs.*, u.nama_lengkap as user_nama
         FROM riwayat_stok rs
         LEFT JOIN users u ON u.id = rs.user_id
         WHERE rs.produk_id = ?
         ORDER BY rs.created_at DESC
         LIMIT ?`
      )
      .bind(id, limit)
      .all();

    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: false, error: 'Gagal mengambil riwayat stok' }, 500);
  }
});

// ==========================================================
// GALERI FOTO TAMBAHAN
// ==========================================================

produk.get('/:id/galeri', requireAuth, async (c) => {
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

produk.post('/:id/galeri', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
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

    const kuotaErr = await cekKuotaR2(c.env.IMAGES, session.toko_pusat_id, file.size);
    if (kuotaErr) return c.json({ success: false, error: kuotaErr }, 403);

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

produk.delete('/:id/galeri/:galeriId', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
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

// ==========================================================
// UPLOAD FOTO PRODUK (R2)
// Mount: /api/upload → path di sini relatif, jadi POST /api/upload/produk
// ==========================================================

produk.post('/produk', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
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

    const oldGambarUrl = typeof body['old_gambar_url'] === 'string' ? body['old_gambar_url'] : null;
    const kuotaErr = await cekKuotaR2(c.env.IMAGES, session.toko_pusat_id, file.size, oldGambarUrl);
    if (kuotaErr) return c.json({ success: false, error: kuotaErr }, 403);

    const key = `produk/${session.toko_pusat_id}/${crypto.randomUUID()}.${ext}`;
    await c.env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

    const gambarUrl = `${new URL(c.req.url).origin}/kasir/api/gambar/${key}`;
    return c.json({ success: true, gambar_url: gambarUrl }, 201);
  } catch {
    return c.json({ success: false, error: 'Gagal upload gambar' }, 500);
  }
});

// ==========================================================
// UPLOAD ASET ETALASE (logo, banner)
// Mount: /api/upload → POST /api/upload/etalase
// ==========================================================

produk.post('/etalase', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
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
    const kuotaErr = await cekKuotaR2(c.env.IMAGES, session.toko_pusat_id, file.size);
    if (kuotaErr) return c.json({ success: false, error: kuotaErr }, 403);

    const key = `etalase/${session.toko_pusat_id}/${crypto.randomUUID()}.${ext}`;
    await c.env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

    const url = `${new URL(c.req.url).origin}/kasir/api/gambar/${key}`;
    return c.json({ success: true, url }, 201);
  } catch {
    return c.json({ success: false, error: 'Gagal upload gambar' }, 500);
  }
});

// ==========================================================
// SERVE GAMBAR DARI R2 (publik, tanpa auth)
// Mount: /api/gambar → GET /api/gambar/:key
// ==========================================================

produk.get('/*', async (c) => {
  // c.req.path di sini sudah strip /api/gambar (karena di-mount di /api/gambar)
  // jadi path-nya seperti '/produk/1/abc.jpg', strip leading slash saja
  const key = c.req.path.replace(/^\//, '');
  const obj = await c.env.IMAGES.get(key);
  if (!obj) return c.json({ success: false, error: 'Gambar tidak ditemukan' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: obj.httpEtag,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

export default produk;
