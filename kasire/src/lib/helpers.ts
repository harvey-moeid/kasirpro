// ==========================================================
// helpers.ts — Pure helper functions (tidak ada side-effect I/O kecuali DB/R2)
// ==========================================================

import type { SessionPayload, PembayaranInput } from './types';
import { METODE_BAYAR_VALID, R2_MAX_BYTES_TOTAL } from './types';

// ---- Waktu WIB --------------------------------------------

/**
 * WIB = UTC+7. Semua kolom `created_at` disimpan UTC oleh D1.
 * Ekspresi SQL ini menggeser ke WIB sebelum dibandingkan per-tanggal,
 * supaya laporan tidak meleset untuk transaksi jam 00:00–06:59 WIB.
 */
export function wibDateExpr(column: string): string {
  return `date(datetime(${column}, '+7 hours'))`;
}

/** Tanggal hari ini versi WIB (YYYY-MM-DD) */
export function todayWIB(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---- Kode transaksi ----------------------------------------

/**
 * Generate kode transaksi unik: TRX-YYYYMMDD-NNNNNN (6 digit acak).
 * Pemanggil WAJIB retry kalau kena UNIQUE constraint (maks 3x — lihat POST /api/transaksi).
 */
export function kodeTransaksi(): string {
  const tgl = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `TRX-${tgl}-${rand}`;
}

// ---- Validasi harga & stok --------------------------------

export function validasiHargaStok(body: any): { ok: true } | { ok: false; error: string } {
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

// ---- Split payment ----------------------------------------

type SplitOk = { ok: true; entries: PembayaranInput[]; cashTotal: number; kembalian: number; metodeFinal: string };
type SplitErr = { ok: false; error: string };

/**
 * Validasi & hitung ringkasan split payment.
 * Kembalian HANYA sah untuk metode 'cash' — QRIS/transfer/debit tidak punya kembalian fisik.
 */
export function hitungSplitPayment(pembayaran: any, totalBayar: number): SplitOk | SplitErr {
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

// ---- DB helpers -------------------------------------------

/** Semua toko_id milik 1 tenant (toko_pusat_id). */
export async function getTokoIdsUntukTenant(db: D1Database, tokoPusatId: number): Promise<number[]> {
  const { results } = await db
    .prepare('SELECT id FROM toko WHERE toko_pusat_id = ?')
    .bind(tokoPusatId)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/**
 * Daftar toko_id yang boleh diakses sesi ini.
 * - kasir/admin_toko: hanya toko sendiri.
 * - super_admin: semua cabang dalam tenant-nya.
 */
export async function getTokoIdsUntukSesi(db: D1Database, session: SessionPayload): Promise<number[]> {
  if (session.role !== 'super_admin') {
    return session.toko_id ? [session.toko_id] : [];
  }
  return getTokoIdsUntukTenant(db, session.toko_pusat_id);
}

/**
 * Validasi toko_id dari client benar-benar milik tenant sesi ini.
 * Return null jika tidak valid — WAJIB dipanggil setiap endpoint yang terima toko_id dari client.
 */
export async function validasiTokoIdMilikTenant(
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

/**
 * Ambil produk by ID + validasi kepemilikan tenant/toko.
 * super_admin: harus dalam tenant yang sama. admin_toko: harus toko yang sama.
 */
export async function getProdukAtauTolak(
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
  if (produk.toko_pusat_id !== session.toko_pusat_id) {
    return { error: Response.json({ success: false, error: 'Produk tidak ditemukan' }, { status: 404 }) };
  }
  if (session.role !== 'super_admin' && produk.toko_id !== session.toko_id) {
    return { error: Response.json({ success: false, error: 'Produk ini bukan milik toko Anda' }, { status: 403 }) };
  }
  return { produk };
}

/**
 * Catat satu baris audit trail ke `log_aktivitas`. Fire-and-forget.
 * Gagal mencatat log TIDAK boleh menggagalkan aksi utama.
 */
export async function catatLog(
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

// ---- R2 helpers -------------------------------------------

/**
 * Hitung total ukuran object R2 untuk satu prefix (byte).
 * Loop pagination karena R2 list() maks 1000 key per panggilan.
 */
export async function hitungTotalUkuranR2(bucket: R2Bucket, prefix?: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor, limit: 1000, prefix });
    for (const obj of listed.objects) total += obj.size;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}

/**
 * Hitung total ukuran R2 untuk 1 tenant (prefix `produk/{id}/` + `etalase/{id}/`).
 * Dipakai untuk cek kuota sebelum upload — tidak perlu scan seluruh bucket lintas tenant.
 */
export async function hitungTotalUkuranR2UntukTenant(bucket: R2Bucket, tokoPusatId: number): Promise<number> {
  const [produkBytes, etalaseBytes] = await Promise.all([
    hitungTotalUkuranR2(bucket, `produk/${tokoPusatId}/`),
    hitungTotalUkuranR2(bucket, `etalase/${tokoPusatId}/`),
  ]);
  return produkBytes + etalaseBytes;
}

/**
 * Ekstrak key R2 dari gambar_url yang disimpan di DB.
 * Menerima URL relatif (/api/gambar/xxx) maupun absolut.
 * Return null untuk URL eksternal yang bukan milik kita.
 */
export function r2KeyDariGambarUrl(gambarUrl: string | null | undefined): string | null {
  if (!gambarUrl) return null;
  const m = gambarUrl.match(/\/api\/gambar\/(.+)$/);
  return m ? m[1] : null;
}

/**
 * Cek kuota R2 tenant sebelum upload. Mendukung penggantian foto (old_gambar_url):
 * ukuran foto lama dikecualikan dari hitungan kuota supaya replace foto
 * tidak ditolak salah di ambang batas.
 * Return null jika masih ada ruang, atau string pesan error jika penuh.
 */
export async function cekKuotaR2(
  bucket: R2Bucket,
  tokoPusatId: number,
  fileSize: number,
  oldGambarUrl?: string | null
): Promise<string | null> {
  let totalEfektif = await hitungTotalUkuranR2UntukTenant(bucket, tokoPusatId);
  const oldKey = r2KeyDariGambarUrl(oldGambarUrl ?? null);
  if (oldKey) {
    const oldObj = await bucket.head(oldKey);
    if (oldObj) totalEfektif -= oldObj.size;
  }
  if (totalEfektif + fileSize > R2_MAX_BYTES_TOTAL) {
    const sisaMb = Math.max(0, (R2_MAX_BYTES_TOTAL - totalEfektif) / 1024 / 1024).toFixed(1);
    return `Batas maksimal 500MB penyimpanan gambar sudah tercapai. Upgrade langganan untuk menambah kuota. (sisa kuota: ${sisaMb}MB)`;
  }
  return null;
}
