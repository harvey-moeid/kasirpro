import { Hono } from 'hono';
import { requireAuth, requireRole } from '../lib/auth-middleware';
import { verifyPassword } from '../lib/crypto';
import type { AppEnv } from '../lib/types';
import {
  catatLog,
  hitungSplitPayment,
  kodeTransaksi,
  wibDateExpr,
  todayWIB,
  getTokoIdsUntukSesi,
  getTokoIdsUntukTenant,
  validasiTokoIdMilikTenant,
} from '../lib/helpers';

// ==========================================================
// SHIFT (di-mount di /api/shift)
// Path di sini relatif → POST /api/shift/buka, GET /api/shift/aktif, dst.
// ==========================================================

export const shiftRoutes = new Hono<AppEnv>();

shiftRoutes.post('/buka', requireAuth, async (c) => {
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

shiftRoutes.get('/aktif', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const shift = await db
    .prepare("SELECT * FROM shift_kasir WHERE kasir_id = ? AND status = 'buka' ORDER BY id DESC LIMIT 1")
    .bind(session.uid)
    .first<any>();
  if (!shift) return c.json({ success: true, data: null });

  const kasSaatIni = await db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(tp.jumlah) FROM transaksi_pembayaran tp
                    JOIN transaksi t ON t.id = tp.transaksi_id
                    WHERE t.shift_id = ? AND tp.metode_bayar = 'cash' AND t.status = 'selesai'), 0) as total_tunai_diterima,
         COALESCE((SELECT SUM(t.kembalian) FROM transaksi t WHERE t.shift_id = ? AND t.status = 'selesai'), 0) as total_kembalian,
         COALESCE((SELECT SUM(r.total_retur) FROM retur r
                    JOIN transaksi t ON t.id = r.transaksi_id
                    WHERE t.shift_id = ? AND r.metode_pengembalian = 'cash'), 0) as total_retur_tunai`
    )
    .bind(shift.id, shift.id, shift.id)
    .first<any>();

  const netTunai =
    (kasSaatIni?.total_tunai_diterima ?? 0) -
    (kasSaatIni?.total_kembalian ?? 0) -
    (kasSaatIni?.total_retur_tunai ?? 0);

  return c.json({ success: true, data: { ...shift, perkiraan_kas_saat_ini: shift.modal_awal + netTunai } });
});

shiftRoutes.post('/tutup', requireAuth, async (c) => {
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
    if (!shift) return c.json({ success: false, error: 'Tidak ada shift aktif untuk ditutup' }, 404);

    const rekap = await db
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(tp.jumlah) FROM transaksi_pembayaran tp
                      JOIN transaksi t ON t.id = tp.transaksi_id
                      WHERE t.shift_id = ? AND tp.metode_bayar = 'cash' AND t.status = 'selesai'), 0) as total_tunai_diterima,
           COALESCE((SELECT SUM(t.kembalian) FROM transaksi t WHERE t.shift_id = ? AND t.status = 'selesai'), 0) as total_kembalian,
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
        `UPDATE shift_kasir SET status='tutup', waktu_tutup=datetime('now'),
         kas_sistem_akhir=?, kas_fisik_akhir=?, selisih=?, catatan=? WHERE id=?`
      )
      .bind(kasSistemAkhir, kasFisikNum, selisih, catatan ?? null, shift.id)
      .run();

    const updated = await db.prepare('SELECT * FROM shift_kasir WHERE id = ?').bind(shift.id).first();
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Gagal menutup shift' }, 400);
  }
});

shiftRoutes.get('/', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  let sql = `SELECT sk.*, u.nama_lengkap as kasir_nama, t.nama as toko_nama
             FROM shift_kasir sk
             JOIN users u ON u.id = sk.kasir_id
             JOIN toko t ON t.id = sk.toko_id
             WHERE t.toko_pusat_id = ?`;
  const params: any[] = [session.toko_pusat_id];

  if (session.role === 'admin_toko') { sql += ' AND sk.toko_id = ?'; params.push(session.toko_id); }
  sql += ' ORDER BY sk.waktu_buka DESC LIMIT 100';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// ==========================================================
// TRANSAKSI (di-mount di /api/transaksi)
// ==========================================================

export const transaksiRoutes = new Hono<AppEnv>();

transaksiRoutes.post('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  try {
    const body = await c.req.json<any>();
    const { offline_uuid, items, diskon = 0, pajak = 0 } = body;
    // FIX B1: super_admin punya session.toko_id = null, jatuh ke body.toko_id.
    // Wajib validasi kepemilikan tenant — kalau tidak, super_admin tenant A
    // bisa membuat transaksi di toko tenant B (cross-tenant attack).
    const toko_id =
      session.role === 'super_admin'
        ? await validasiTokoIdMilikTenant(db, session, body.toko_id)
        : session.toko_id;
    const kasir_id = session.uid;

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: 'Item transaksi kosong' }, 400);
    }
    if (!toko_id) {
      return c.json({ success: false, error: 'toko_id wajib ditentukan/tidak valid untuk transaksi ini' }, 400);
    }

    // Validasi bentuk item
    for (const item of items) {
      if (typeof item?.id !== 'number') {
        return c.json({ success: false, error: 'ID produk tidak valid pada salah satu item' }, 400);
      }
      if (!Number.isInteger(item?.qty) || item.qty <= 0) {
        return c.json({ success: false, error: `Qty tidak valid untuk item id=${item?.id}` }, 400);
      }
      if (item?.diskon_item != null && !Number.isFinite(Number(item.diskon_item))) {
        return c.json({ success: false, error: `Diskon item tidak valid untuk item id=${item?.id}` }, 400);
      }
    }

    // Cek shift aktif (wajib untuk role kasir)
    const shiftAktif = await db
      .prepare("SELECT id FROM shift_kasir WHERE kasir_id = ? AND status = 'buka' ORDER BY id DESC LIMIT 1")
      .bind(kasir_id)
      .first<any>();
    if (!shiftAktif && session.role === 'kasir') {
      return c.json({ success: false, error: 'Belum ada shift aktif — buka shift dulu sebelum mulai transaksi' }, 409);
    }
    const shift_id = shiftAktif?.id ?? null;

    // Idempotency offline
    if (offline_uuid) {
      const existing = await db
        .prepare('SELECT id, kode_transaksi FROM transaksi WHERE offline_uuid = ?')
        .bind(offline_uuid)
        .first<any>();
      if (existing) {
        return c.json({ success: true, message: 'Sudah tersinkronisasi sebelumnya', kode_transaksi: existing.kode_transaksi });
      }
    }

    // Ambil data produk dari DB (server-truth — harga tidak pernah percaya client)
    const produkIds = [...new Set(items.map((i: any) => i.id))];
    const { results: produkRows } = await db
      .prepare(`SELECT id, nama, harga_jual, harga_beli, stok, is_active, toko_id FROM produk WHERE id IN (${produkIds.map(() => '?').join(',')})`)
      .bind(...produkIds)
      .all<any>();
    const produkMap = new Map(produkRows.map((p: any) => [p.id, p]));

    // Validasi kepemilikan toko & status aktif
    const tidakValid = items.filter((item: any) => {
      const p = produkMap.get(item.id);
      return !p || p.is_active !== 1 || p.toko_id !== toko_id;
    }).map((item: any) => item.id);
    if (tidakValid.length > 0) {
      return c.json({ success: false, error: `Produk tidak valid untuk transaksi ini: id ${tidakValid.join(', ')}` }, 400);
    }

    // Hitung subtotal dari harga DB
    let subtotal = 0;
    for (const item of items) {
      const p = produkMap.get(item.id)!;
      const hargaAsliBaris = p.harga_jual * item.qty;
      const diskonItemNum = Number(item.diskon_item ?? 0);
      if (diskonItemNum < 0) {
        return c.json({ success: false, error: `Diskon item tidak boleh negatif untuk item id=${item.id}` }, 400);
      }
      if (diskonItemNum > hargaAsliBaris + 0.01) {
        return c.json({ success: false, error: `Diskon item melebihi harga baris untuk "${p.nama}"` }, 400);
      }
      subtotal += hargaAsliBaris - diskonItemNum;
    }

    // Validasi diskon & pajak
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

    // Normalisasi format pembayaran (support format lama dan baru)
    const pembayaranInput =
      body.pembayaran ??
      (body.metode_bayar
        ? [{ metode: body.metode_bayar, jumlah: body.metode_bayar === 'cash' ? body.uang_diterima ?? total_bayar : total_bayar }]
        : null);
    if (!pembayaranInput) {
      return c.json({ success: false, error: 'Rincian pembayaran wajib diisi' }, 400);
    }

    const split = hitungSplitPayment(pembayaranInput, total_bayar);
    if (!split.ok) return c.json({ success: false, error: split.error }, 400);

    // Insert dengan retry kode_transaksi (maks 3x)
    let kode_trx = kodeTransaksi();
    const MAX_RETRY = 3;

    for (let percobaan = 1; ; percobaan++) {
      const stmts = [
        db.prepare(
          `INSERT INTO transaksi
             (kode_transaksi, toko_id, kasir_id, total_belanja, diskon, pajak, total_bayar,
              metode_bayar, uang_diterima, kembalian, offline_uuid, shift_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          kode_trx, toko_id, kasir_id, total_belanja, diskonNum, pajakNum, total_bayar,
          split.metodeFinal,
          split.cashTotal > 0 ? split.cashTotal : null,
          split.kembalian,
          offline_uuid ?? null,
          shift_id
        ),
      ];

      for (const entry of split.entries) {
        stmts.push(
          db.prepare(
            `INSERT INTO transaksi_pembayaran (transaksi_id, metode_bayar, jumlah)
             VALUES ((SELECT id FROM transaksi WHERE kode_transaksi = ?), ?, ?)`
          ).bind(kode_trx, entry.metode, entry.jumlah)
        );
      }

      const stokMap = new Map(produkRows.map((p: any) => [p.id, p.stok as number]));
      for (const item of items) {
        const p = produkMap.get(item.id)!;
        const stokSebelum = stokMap.get(item.id) ?? p.stok;
        const stokSesudah = stokSebelum - item.qty;
        stokMap.set(item.id, stokSesudah);
        const diskonItemNum = Number(item.diskon_item ?? 0);
        const subtotalBaris = p.harga_jual * item.qty - diskonItemNum;

        stmts.push(
          db.prepare(
            `INSERT INTO detail_transaksi (transaksi_id, produk_id, nama_produk, harga_satuan, qty, subtotal, hpp_satuan, diskon_item)
             VALUES ((SELECT id FROM transaksi WHERE kode_transaksi = ?), ?, ?, ?, ?, ?, ?, ?)`
          ).bind(kode_trx, item.id, p.nama, p.harga_jual, item.qty, subtotalBaris, p.harga_beli ?? 0, diskonItemNum),
          db.prepare(`UPDATE produk SET stok=?, updated_at=datetime('now') WHERE id=?`).bind(stokSesudah, item.id),
          db.prepare(
            `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
             VALUES (?, 'keluar', ?, ?, ?, ?, ?)`
          ).bind(item.id, item.qty, stokSebelum, stokSesudah, kode_trx, kasir_id)
        );
      }

      try {
        await db.batch(stmts);
        break;
      } catch (err: any) {
        if (String(err?.message ?? '').includes('kode_transaksi') && percobaan < MAX_RETRY) {
          kode_trx = kodeTransaksi();
          continue;
        }
        throw err;
      }
    }

    return c.json({ success: true, kode_transaksi: kode_trx, kembalian: split.kembalian, metode_bayar: split.metodeFinal }, 201);
  } catch (err: any) {
    const pesan = String(err?.message ?? '');
    const msg = pesan.includes('offline_uuid')
      ? 'Transaksi dengan offline_uuid ini sudah pernah masuk'
      : pesan.includes('kode_transaksi')
        ? 'Gagal membuat kode transaksi unik, silakan coba lagi'
        : 'Gagal menyimpan transaksi';
    return c.json({ success: false, error: msg }, 500);
  }
});

// ==========================================================
// TRANSAKSI — LIST & DETAIL
// ==========================================================

transaksiRoutes.get('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { tanggal, dari, sampai, kasir_id } = c.req.query();
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 500) || 500, 1), 5000);

  let sql = `SELECT t.*, u.nama_lengkap as kasir_nama
             FROM transaksi t
             JOIN users u ON u.id = t.kasir_id
             JOIN toko tk ON tk.id = t.toko_id
             WHERE tk.toko_pusat_id = ?`;
  const params: any[] = [session.toko_pusat_id];

  if (session.role === 'kasir') { sql += ' AND t.kasir_id = ?'; params.push(session.uid); }
  else if (session.role === 'admin_toko') { sql += ' AND t.toko_id = ?'; params.push(session.toko_id); }
  else if (kasir_id) { sql += ' AND t.kasir_id = ?'; params.push(kasir_id); }

  if (tanggal) { sql += ` AND ${wibDateExpr('t.created_at')} = date(?)`; params.push(tanggal); }
  if (dari) { sql += ` AND ${wibDateExpr('t.created_at')} >= date(?)`; params.push(dari); }
  if (sampai) { sql += ` AND ${wibDateExpr('t.created_at')} <= date(?)`; params.push(sampai); }

  sql += ' ORDER BY t.created_at DESC LIMIT ' + (limit + 1);

  const { results } = await db.prepare(sql).bind(...params).all<any>();
  const truncated = results.length > limit;
  return c.json({ success: true, data: truncated ? results.slice(0, limit) : results, truncated });
});

transaksiRoutes.get('/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');

  const trx = await db.prepare('SELECT * FROM transaksi WHERE id = ?').bind(id).first<any>();
  if (!trx) return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);

  const tokoTrx = await db.prepare('SELECT toko_pusat_id FROM toko WHERE id = ?').bind(trx.toko_id).first<any>();
  if (!tokoTrx || tokoTrx.toko_pusat_id !== session.toko_pusat_id) {
    return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
  }
  if (session.role === 'kasir' && trx.kasir_id !== session.uid) {
    return c.json({ success: false, error: 'Transaksi ini bukan milik Anda' }, 403);
  }
  if (session.role === 'admin_toko' && trx.toko_id !== session.toko_id) {
    return c.json({ success: false, error: 'Transaksi ini bukan milik toko Anda' }, 403);
  }

  const [{ results: items }, { results: pembayaran }, { results: retur }] = await Promise.all([
    db.prepare('SELECT * FROM detail_transaksi WHERE transaksi_id = ?').bind(id).all(),
    db.prepare('SELECT metode_bayar, jumlah FROM transaksi_pembayaran WHERE transaksi_id = ?').bind(id).all(),
    db.prepare('SELECT id, total_retur, alasan, created_at FROM retur WHERE transaksi_id = ? ORDER BY created_at DESC').bind(id).all(),
  ]);

  return c.json({ success: true, data: { ...trx, items, pembayaran, retur } });
});

// ==========================================================
// BATALKAN TRANSAKSI
// ==========================================================

transaksiRoutes.post('/:id/batalkan', requireAuth, requireRole('super_admin', 'admin_toko'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');

  try {
    const trx = await db.prepare('SELECT * FROM transaksi WHERE id = ?').bind(id).first<any>();
    if (!trx) return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    if (trx.status === 'dibatalkan') {
      return c.json({ success: false, error: 'Transaksi sudah dibatalkan sebelumnya' }, 400);
    }

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

    const stmts: any[] = [db.prepare("UPDATE transaksi SET status='dibatalkan' WHERE id=?").bind(id)];
    for (const item of items) {
      const produk = await db.prepare('SELECT stok FROM produk WHERE id = ?').bind(item.produk_id).first<any>();
      const stokSebelum = produk?.stok ?? 0;
      const qtyDikembalikan = item.qty - item.qty_retur;
      const stokSesudah = stokSebelum + qtyDikembalikan;

      stmts.push(
        db.prepare(`UPDATE produk SET stok=?, updated_at=datetime('now') WHERE id=?`).bind(stokSesudah, item.produk_id),
        db.prepare(
          `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
           VALUES (?, 'masuk', ?, ?, ?, ?, ?)`
        ).bind(item.produk_id, qtyDikembalikan, stokSebelum, stokSesudah, `Batal ${trx.kode_transaksi}`, session.uid)
      );
    }

    await db.batch(stmts);
    await catatLog(
      db, session, 'batalkan', 'transaksi', trx.id,
      `Membatalkan transaksi ${trx.kode_transaksi} (total Rp${Number(trx.total_bayar).toLocaleString('id-ID')})`
    );
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: 'Gagal membatalkan transaksi' }, 500);
  }
});

// ==========================================================
// RETUR SEBAGIAN ITEM
// ==========================================================

transaksiRoutes.post('/:id/retur', requireAuth, requireRole('super_admin', 'admin_toko', 'kasir'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const items: any[] = Array.isArray(body.items) ? body.items : [];
  const alasan = typeof body.alasan === 'string' && body.alasan.trim() ? body.alasan.trim().slice(0, 500) : null;

  if (items.length === 0) return c.json({ success: false, error: 'Pilih minimal 1 item untuk diretur' }, 400);

  const metodePengembalian = body.metode_pengembalian;
  if (metodePengembalian !== 'cash' && metodePengembalian !== 'non_cash') {
    return c.json(
      { success: false, error: "metode_pengembalian wajib diisi: 'cash' atau 'non_cash'" },
      400
    );
  }

  // Kasir butuh konfirmasi password sendiri
  if (session.role === 'kasir') {
    const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : '';
    if (!confirmPassword) return c.json({ success: false, error: 'Konfirmasi password diperlukan untuk retur' }, 400);
    const diriSendiri = await db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(session.uid).first<any>();
    const valid = diriSendiri
      ? await verifyPassword(confirmPassword, diriSendiri.password_hash, diriSendiri.password_salt)
      : await verifyPassword(confirmPassword, '', 'AAAAAAAAAAAAAAAAAAAAAA==');
    if (!diriSendiri || !valid) return c.json({ success: false, error: 'Password salah' }, 403);
  }

  try {
    const trx = await db.prepare('SELECT * FROM transaksi WHERE id = ?').bind(id).first<any>();
    if (!trx) return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    if (trx.status === 'dibatalkan') {
      return c.json({ success: false, error: 'Transaksi ini sudah dibatalkan, tidak bisa diretur lagi' }, 400);
    }

    const tokoTrx = await db.prepare('SELECT toko_pusat_id FROM toko WHERE id = ?').bind(trx.toko_id).first<any>();
    if (!tokoTrx || tokoTrx.toko_pusat_id !== session.toko_pusat_id) {
      return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    }
    if (session.role !== 'super_admin' && trx.toko_id !== session.toko_id) {
      return c.json({ success: false, error: 'Transaksi ini bukan milik toko Anda' }, 403);
    }
    if (session.role === 'kasir' && trx.kasir_id !== session.uid) {
      return c.json({ success: false, error: 'Transaksi ini bukan milik Anda' }, 403);
    }

    const detailIds = items.map((i: any) => Number(i.detail_id));
    if (detailIds.some((x) => !Number.isInteger(x))) {
      return c.json({ success: false, error: 'detail_id tidak valid pada salah satu item' }, 400);
    }

    const { results: detailRows } = await db
      .prepare(`SELECT * FROM detail_transaksi WHERE transaksi_id = ? AND id IN (${detailIds.map(() => '?').join(',')})`)
      .bind(id, ...detailIds)
      .all<any>();
    const detailMap = new Map(detailRows.map((d: any) => [d.id, d]));

    // Validasi semua item dulu (fail-fast)
    let totalRetur = 0;
    const sisaTerpakai = new Map<number, number>();
    const rencana: { detail: any; qtyRetur: number; subtotalReturItem: number }[] = [];
    for (const item of items) {
      const detailId = Number(item.detail_id);
      const qtyRetur = Number(item.qty);
      const detail = detailMap.get(detailId);
      if (!detail) return c.json({ success: false, error: `Item id=${detailId} bukan bagian dari transaksi ini` }, 400);
      if (!Number.isInteger(qtyRetur) || qtyRetur <= 0) {
        return c.json({ success: false, error: `Qty retur tidak valid untuk "${detail.nama_produk}"` }, 400);
      }
      const sudahDipakai = sisaTerpakai.get(detailId) ?? 0;
      const sisaBisaRetur = detail.qty - detail.qty_retur - sudahDipakai;
      if (qtyRetur > sisaBisaRetur) {
        return c.json({ success: false, error: `Qty retur "${detail.nama_produk}" melebihi sisa (maks ${sisaBisaRetur})` }, 400);
      }
      sisaTerpakai.set(detailId, sudahDipakai + qtyRetur);
      const subtotalPerUnit = detail.subtotal / detail.qty;
      const subtotalReturItem = Math.round(subtotalPerUnit * qtyRetur);
      totalRetur += subtotalReturItem;
      rencana.push({ detail, qtyRetur, subtotalReturItem });
    }

    // FIX B5: sebelumnya 2 db.batch() terpisah — tidak atomic (kalau Worker
    // mati di antaranya, retur header ada tapi retur_item kosong).
    // Solusi: INSERT retur dulu via .run() untuk dapat last_row_id,
    // lalu semua operasi lain (UPDATE + INSERT retur_item) dalam 1 batch.
    const returRun = await db
      .prepare('INSERT INTO retur (transaksi_id, toko_id, user_id, total_retur, alasan, metode_pengembalian) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, trx.toko_id, session.uid, totalRetur, alasan, metodePengembalian)
      .run();
    const returId = returRun.meta.last_row_id;

    const stmts: any[] = [
      db.prepare('UPDATE transaksi SET total_bayar=total_bayar-? WHERE id=?').bind(totalRetur, id),
    ];
    for (const { detail, qtyRetur, subtotalReturItem } of rencana) {
      stmts.push(
        db.prepare('UPDATE detail_transaksi SET qty_retur=qty_retur+?, subtotal_retur=subtotal_retur+? WHERE id=?')
          .bind(qtyRetur, subtotalReturItem, detail.id),
        db.prepare(`UPDATE produk SET stok=stok+?, updated_at=datetime('now') WHERE id=?`).bind(qtyRetur, detail.produk_id),
        db.prepare(
          `INSERT INTO riwayat_stok (produk_id, jenis, jumlah, stok_sebelum, stok_sesudah, referensi, user_id)
           SELECT ?, 'masuk', ?, stok-?, stok, ?, ? FROM produk WHERE id=?`
        ).bind(detail.produk_id, qtyRetur, qtyRetur, `Retur ${trx.kode_transaksi}`, session.uid, detail.produk_id),
        db.prepare(
          `INSERT INTO retur_item (retur_id, detail_transaksi_id, produk_id, nama_produk, qty, subtotal)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(returId, detail.id, detail.produk_id, detail.nama_produk, qtyRetur, subtotalReturItem),
      );
    }
    await db.batch(stmts);

    await catatLog(
      db, session, 'retur', 'transaksi', trx.id,
      `Retur ${rencana.length} item dari ${trx.kode_transaksi} (Rp${totalRetur.toLocaleString('id-ID')})${alasan ? ` — ${alasan}` : ''}`
    );
    return c.json({ success: true, total_retur: totalRetur });
  } catch (err) {
    console.error('Gagal retur:', err);
    return c.json({ success: false, error: 'Gagal memproses retur' }, 500);
  }
});

// ==========================================================
// LAPORAN (di-mount di /api/laporan)
// Path di sini relatif → GET /api/laporan/harian, dst.
// ==========================================================

export const laporanRoutes = new Hono<AppEnv>();

laporanRoutes.get('/harian', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const tanggal = c.req.query('tanggal') ?? todayWIB();

  let sql = `SELECT COUNT(*) as jumlah_transaksi, COALESCE(SUM(total_bayar), 0) as total_penjualan
             FROM transaksi t WHERE ${wibDateExpr('t.created_at')} = date(?) AND t.status = 'selesai'`;
  const params: any[] = [tanggal];

  if (session.role !== 'super_admin') {
    sql += ' AND t.toko_id = ?'; params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: { jumlah_transaksi: 0, total_penjualan: 0 } });
    sql += ` AND t.toko_id IN (${tokoIds.map(() => '?').join(',')})`; params.push(...tokoIds);
  }

  const row = await db.prepare(sql).bind(...params).first();
  return c.json({ success: true, data: row });
});

laporanRoutes.get('/produk-terlaris', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { dari, sampai } = c.req.query();
  const limitNum = Math.min(Math.max(Number(c.req.query('limit') ?? 10) || 10, 1), 200);

  let sql = `SELECT dt.produk_id, dt.nama_produk,
                    SUM(dt.qty - dt.qty_retur) as total_qty,
                    SUM(dt.subtotal - dt.subtotal_retur) as total_omzet
             FROM detail_transaksi dt
             JOIN transaksi t ON t.id = dt.transaksi_id
             WHERE t.status = 'selesai'`;
  const params: any[] = [];

  if (dari) { sql += ` AND ${wibDateExpr('t.created_at')} >= date(?)`; params.push(dari); }
  if (sampai) { sql += ` AND ${wibDateExpr('t.created_at')} <= date(?)`; params.push(sampai); }
  if (session.role !== 'super_admin') {
    sql += ' AND t.toko_id = ?'; params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: [] });
    sql += ` AND t.toko_id IN (${tokoIds.map(() => '?').join(',')})`; params.push(...tokoIds);
  }
  sql += ' GROUP BY dt.produk_id ORDER BY total_qty DESC LIMIT ?'; params.push(limitNum);

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

laporanRoutes.get('/laba', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { dari, sampai } = c.req.query();

  let sql = `SELECT dt.produk_id, dt.nama_produk,
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
    sql += ' AND t.toko_id = ?'; params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) {
      return c.json({ success: true, data: { ringkasan: { omzet: 0, hpp: 0, laba_kotor: 0, margin_persen: 0 }, produk: [] } });
    }
    sql += ` AND t.toko_id IN (${tokoIds.map(() => '?').join(',')})`; params.push(...tokoIds);
  }
  sql += ' GROUP BY dt.produk_id ORDER BY laba_kotor DESC';

  const { results } = await db.prepare(sql).bind(...params).all<any>();
  const ringkasan = results.reduce(
    (acc: any, r: any) => { acc.omzet += r.omzet || 0; acc.hpp += r.hpp || 0; acc.laba_kotor += r.laba_kotor || 0; return acc; },
    { omzet: 0, hpp: 0, laba_kotor: 0 }
  );
  ringkasan.margin_persen = ringkasan.omzet > 0 ? Math.round((ringkasan.laba_kotor / ringkasan.omzet) * 1000) / 10 : 0;
  return c.json({ success: true, data: { ringkasan, produk: results } });
});

laporanRoutes.get('/tren-penjualan', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const hari = Math.min(Math.max(Number(c.req.query('hari') ?? 7), 1), 90);

  let sql = `SELECT ${wibDateExpr('created_at')} as tanggal,
                    COUNT(*) as jumlah_transaksi,
                    COALESCE(SUM(total_bayar), 0) as total_penjualan
             FROM transaksi
             WHERE status = 'selesai' AND ${wibDateExpr('created_at')} >= date(?, ?)`;
  const params: any[] = [todayWIB(), `-${hari - 1} days`];

  if (session.role !== 'super_admin') {
    sql += ' AND toko_id = ?'; params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length > 0) {
      sql += ` AND toko_id IN (${tokoIds.map(() => '?').join(',')})`; params.push(...tokoIds);
    } else { sql += ' AND 0=1'; }
  }
  sql += ` GROUP BY ${wibDateExpr('created_at')} ORDER BY tanggal ASC`;

  const { results } = await db.prepare(sql).bind(...params).all<any>();
  const dataMap = new Map(results.map((r: any) => [r.tanggal, r]));

  const lengkap: any[] = [];
  const hariIniWIB = new Date(Date.now() + 7 * 60 * 60 * 1000);
  for (let i = hari - 1; i >= 0; i--) {
    const d = new Date(hariIniWIB);
    d.setUTCDate(d.getUTCDate() - i);
    const tgl = d.toISOString().slice(0, 10);
    const row = dataMap.get(tgl) as any;
    lengkap.push({ tanggal: tgl, jumlah_transaksi: row?.jumlah_transaksi ?? 0, total_penjualan: row?.total_penjualan ?? 0 });
  }
  return c.json({ success: true, data: lengkap });
});

laporanRoutes.get('/stok-menipis', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const ambang = Math.max(Number(c.req.query('ambang') ?? 10) || 10, 0);

  // FIX B3: p.* menyertakan harga_beli (harga modal) — bocor ke role kasir.
  // Ganti dengan kolom eksplisit: harga_beli hanya ditampilkan untuk admin.
  const kolomHargaBeli = session.role === 'kasir' ? '' : ', p.harga_beli';
  let sql = `SELECT p.id, p.toko_id, p.kategori_id, p.kode_produk, p.nama,
                    p.harga_jual${kolomHargaBeli}, p.stok, p.satuan, p.gambar_url,
                    p.is_active, p.slug, p.updated_at, tk.nama as nama_toko
             FROM produk p JOIN toko tk ON tk.id = p.toko_id
             WHERE p.is_active = 1 AND p.stok <= ?`;
  const params: any[] = [ambang];

  if (session.role !== 'super_admin') {
    sql += ' AND p.toko_id = ?'; params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: [] });
    sql += ` AND p.toko_id IN (${tokoIds.map(() => '?').join(',')})`; params.push(...tokoIds);
  }
  sql += ' ORDER BY p.stok ASC';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// Laporan per metode bayar (baru)
laporanRoutes.get('/metode-bayar', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const { dari, sampai } = c.req.query();

  let sql = `SELECT tp.metode_bayar, SUM(tp.jumlah) as total, COUNT(DISTINCT t.id) as jumlah_transaksi
             FROM transaksi_pembayaran tp
             JOIN transaksi t ON t.id = tp.transaksi_id
             WHERE t.status = 'selesai'`;
  const params: any[] = [];

  if (dari) { sql += ` AND ${wibDateExpr('t.created_at')} >= date(?)`; params.push(dari); }
  if (sampai) { sql += ` AND ${wibDateExpr('t.created_at')} <= date(?)`; params.push(sampai); }
  if (session.role !== 'super_admin') {
    sql += ' AND t.toko_id = ?'; params.push(session.toko_id);
  } else {
    const tokoIds = await getTokoIdsUntukTenant(db, session.toko_pusat_id);
    if (tokoIds.length === 0) return c.json({ success: true, data: [] });
    sql += ` AND t.toko_id IN (${tokoIds.map(() => '?').join(',')})`; params.push(...tokoIds);
  }
  sql += ' GROUP BY tp.metode_bayar ORDER BY total DESC';

  const { results } = await db.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// Named exports: shiftRoutes, transaksiRoutes, laporanRoutes
