-- ==========================================================
-- Migration 0001 — Skema Terpadu: Kasir + Etalase Online
-- ==========================================================
-- 1 Database (D1) dipakai bersama oleh 2 Worker di 1 domain (path-based
-- routing, lihat ARSITEKTUR.md):
--   - Worker "kasire"  (domainanda.com/kasir)  -> kasir + SATU-SATUNYA
--     panel admin (produk, kategori, user, laporan, DAN kelola etalase:
--     visibilitas produk online, pengaturan toko, riwayat pesanan WA).
--     Sumber kebenaran data produk, harga, dan STOK.
--   - Worker "etalase" (domainanda.com/)        -> etalase online publik,
--     HANYA baca (tidak ada admin/login di sini lagi -- 1 admin, 1 login,
--     semua lewat kasire). Tidak ada tabel produk terpisah -> "produk
--     saling terhubung" & "stok etalase ikut kasir" otomatis, karena
--     memang baris data yang sama, bukan hasil sinkron.
--
-- Skema ini dibangun dari 0 (bukan hasil ALTER migrasi lama) supaya
-- final state-nya bersih dan mudah dibaca.
--
-- Jalankan SEKALI SAJA lewat salah satu project:
--   wrangler d1 migrations apply kasire --remote   (dari folder kasire
--   ATAU etalase, keduanya sudah dikonfigurasi menunjuk ke database_id
--   yang sama)
-- ==========================================================

PRAGMA foreign_keys = ON;

-- ==========================================================
-- 1. TOKO / CABANG (dipakai kasir untuk multi-cabang; web toko
--    online cuma menampilkan SATU cabang, lihat store_settings.toko_id)
-- ==========================================================
-- ==========================================================
-- 0. TOKO PUSAT — level TENANT (1 baris = 1 pelanggan/bisnis berbeda).
--    Isolasi multi-tenant SELURUH sistem berpatokan ke toko_pusat_id ini
--    -- 1 database dipakai bersama BANYAK bisnis berbeda, tapi masing-
--    masing TIDAK BOLEH saling lihat data (lihat audit di ARSITEKTUR.md).
-- ==========================================================
CREATE TABLE toko_pusat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE toko (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  toko_pusat_id INTEGER NOT NULL REFERENCES toko_pusat(id),
  nama TEXT NOT NULL,
  alamat TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_toko_pusat ON toko(toko_pusat_id);

-- ==========================================================
-- 2. USERS — akun kasir (super_admin / admin_toko / kasir)
-- ==========================================================
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  nama_lengkap TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','admin_toko','kasir')),
  toko_pusat_id INTEGER NOT NULL REFERENCES toko_pusat(id), -- batas TENANT,
                     -- berlaku utk SEMUA role (termasuk super_admin -- ini
                     -- yang bikin super_admin sekarang TIDAK bisa lihat
                     -- toko_pusat lain, beda dari sebelumnya yang global).
  toko_id INTEGER REFERENCES toko(id), -- batas CABANG, NULL utk super_admin
                     -- (dia urus semua cabang DALAM toko_pusat-nya).
  is_active INTEGER DEFAULT 1,
  hidden_tabs TEXT, -- JSON array tab yg disembunyikan PRIBADI oleh akun ini
                     -- (preferensi individual, terpisah dari kebijakan per-
                     -- cabang di pengaturan.admin_tabs_enabled)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_toko ON users(toko_id);
CREATE INDEX idx_users_toko_pusat ON users(toko_pusat_id);

-- ==========================================================
-- 3. KATEGORI — dipakai bersama kasir & web toko (slug/urutan
--    dipakai storefront untuk filter kategori; kasir abaikan saja)
-- ==========================================================
CREATE TABLE kategori (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  toko_pusat_id INTEGER NOT NULL REFERENCES toko_pusat(id), -- dipakai bersama
                     -- SEMUA cabang DALAM 1 tenant, TAPI TIDAK lintas tenant
                     -- (beda bisnis harus punya daftar kategori sendiri2).
  nama TEXT NOT NULL,
  slug TEXT,
  urutan INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_kategori_tenant ON kategori(toko_pusat_id);
CREATE UNIQUE INDEX idx_kategori_slug ON kategori(toko_pusat_id, slug) WHERE slug IS NOT NULL;

-- ==========================================================
-- 4. PRODUK — tabel INTI yang dibagi kasir & web toko.
--    - Kolom asli kasir: harga_beli, harga_jual, stok, kode_produk, dst.
--    - Kolom tambahan khusus storefront: slug, deskripsi_toko,
--      harga_coret, tampil_online, urutan_tampil.
--    - STOK cuma pernah ditulis dari sisi kasir (transaksi & koreksi
--      stok) — web toko HANYA membaca kolom `stok`, tidak pernah
--      menulisnya. Itu sebabnya stok di web toko otomatis akurat
--      real-time tanpa perlu proses sync terpisah.
-- ==========================================================
CREATE TABLE produk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  toko_id INTEGER NOT NULL REFERENCES toko(id),
  kategori_id INTEGER REFERENCES kategori(id),
  kode_produk TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  harga_beli REAL DEFAULT 0,
  harga_jual REAL NOT NULL,
  stok INTEGER NOT NULL DEFAULT 0,
  satuan TEXT DEFAULT 'pcs',
  gambar_url TEXT,
  is_active INTEGER DEFAULT 1,

  -- ---- khusus web toko online ----
  slug TEXT,
  deskripsi_toko TEXT,
  harga_coret REAL,
  tampil_online INTEGER NOT NULL DEFAULT 0,
  urutan_tampil INTEGER NOT NULL DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_produk_toko ON produk(toko_id, is_active);
CREATE INDEX idx_produk_kode ON produk(kode_produk);
CREATE UNIQUE INDEX idx_produk_slug ON produk(slug) WHERE slug IS NOT NULL;
CREATE INDEX idx_produk_tampil_online ON produk(toko_id, tampil_online, is_active);

-- Galeri foto tambahan per produk khusus storefront (foto utama tetap
-- di produk.gambar_url yang dikelola dari kasir & dipakai bersama).
CREATE TABLE produk_galeri (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produk_id INTEGER NOT NULL REFERENCES produk(id) ON DELETE CASCADE,
  image_key TEXT NOT NULL,
  urutan INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_produk_galeri_produk ON produk_galeri(produk_id);

-- ==========================================================
-- 5. SHIFT KASIR
-- ==========================================================
CREATE TABLE shift_kasir (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kasir_id INTEGER NOT NULL REFERENCES users(id),
  toko_id INTEGER NOT NULL REFERENCES toko(id),
  modal_awal REAL NOT NULL,
  kas_sistem_akhir REAL,
  kas_fisik_akhir REAL,
  selisih REAL,
  catatan TEXT,
  status TEXT NOT NULL DEFAULT 'buka' CHECK(status IN ('buka','tutup')),
  waktu_buka TEXT DEFAULT (datetime('now')),
  waktu_tutup TEXT
);
CREATE INDEX idx_shift_kasir_status ON shift_kasir(kasir_id, status);
CREATE INDEX idx_shift_toko_waktu ON shift_kasir(toko_id, waktu_buka);

-- ==========================================================
-- 6. TRANSAKSI (kasir) + rincian pembayaran per metode
-- ==========================================================
CREATE TABLE transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode_transaksi TEXT UNIQUE NOT NULL,
  toko_id INTEGER NOT NULL REFERENCES toko(id),
  kasir_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER REFERENCES shift_kasir(id),
  total_belanja REAL NOT NULL,
  diskon REAL DEFAULT 0,
  pajak REAL DEFAULT 0,
  total_bayar REAL NOT NULL,
  metode_bayar TEXT CHECK(metode_bayar IN ('cash','transfer','qris','debit','split')),
  uang_diterima REAL,
  kembalian REAL DEFAULT 0,
  status TEXT DEFAULT 'selesai' CHECK(status IN ('selesai','dibatalkan')),
  offline_uuid TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_transaksi_toko_tanggal ON transaksi(toko_id, created_at);
CREATE INDEX idx_transaksi_shift ON transaksi(shift_id);

CREATE TABLE transaksi_pembayaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaksi_id INTEGER NOT NULL REFERENCES transaksi(id),
  metode_bayar TEXT NOT NULL CHECK(metode_bayar IN ('cash','transfer','qris','debit')),
  jumlah REAL NOT NULL CHECK(jumlah > 0),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_pembayaran_transaksi ON transaksi_pembayaran(transaksi_id);

CREATE TABLE detail_transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaksi_id INTEGER NOT NULL REFERENCES transaksi(id),
  produk_id INTEGER NOT NULL REFERENCES produk(id),
  nama_produk TEXT NOT NULL,
  harga_satuan REAL NOT NULL,
  qty INTEGER NOT NULL,
  subtotal REAL NOT NULL,
  hpp_satuan REAL DEFAULT 0,
  diskon_item REAL NOT NULL DEFAULT 0,
  qty_retur INTEGER NOT NULL DEFAULT 0,
  subtotal_retur REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_detail_transaksi_id ON detail_transaksi(transaksi_id);

-- ==========================================================
-- 7. RIWAYAT STOK (audit trail — SATU-SATUNYA jalur perubahan stok)
-- ==========================================================
CREATE TABLE riwayat_stok (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produk_id INTEGER NOT NULL REFERENCES produk(id),
  jenis TEXT CHECK(jenis IN ('masuk','keluar','koreksi')),
  jumlah INTEGER NOT NULL,
  stok_sebelum INTEGER NOT NULL,
  stok_sesudah INTEGER NOT NULL,
  referensi TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_riwayat_stok_produk ON riwayat_stok(produk_id);

-- ==========================================================
-- 8. RETUR
-- ==========================================================
CREATE TABLE retur (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaksi_id INTEGER NOT NULL REFERENCES transaksi(id),
  toko_id INTEGER NOT NULL REFERENCES toko(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_retur REAL NOT NULL,
  alasan TEXT,
  metode_pengembalian TEXT NOT NULL DEFAULT 'cash' CHECK(metode_pengembalian IN ('cash','non_cash')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_retur_transaksi ON retur(transaksi_id);

CREATE TABLE retur_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  retur_id INTEGER NOT NULL REFERENCES retur(id),
  detail_transaksi_id INTEGER NOT NULL REFERENCES detail_transaksi(id),
  produk_id INTEGER NOT NULL REFERENCES produk(id),
  nama_produk TEXT NOT NULL,
  qty INTEGER NOT NULL,
  subtotal REAL NOT NULL
);
CREATE INDEX idx_retur_item_retur ON retur_item(retur_id);

-- ==========================================================
-- 9. LOG AKTIVITAS (audit CRUD admin)
-- ==========================================================
CREATE TABLE log_aktivitas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  username TEXT NOT NULL,
  toko_id INTEGER REFERENCES toko(id),
  aksi TEXT NOT NULL,
  entitas TEXT NOT NULL,
  entitas_id INTEGER,
  keterangan TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_log_aktivitas_toko_waktu ON log_aktivitas(toko_id, created_at);
CREATE INDEX idx_log_aktivitas_user ON log_aktivitas(user_id);

-- ==========================================================
-- 10. PENGATURAN (key/value) — aplikasi kasir (judul, struk, dst.)
-- ==========================================================
-- Pengaturan (judul app, kustomisasi struk) — 1 SET NILAI PER CABANG
-- (toko_id), bukan 1 global untuk semua cabang. Cabang baru mulai dari
-- default sistem (kosong), bukan warisan dari cabang lain.
CREATE TABLE pengaturan (
  toko_id INTEGER NOT NULL REFERENCES toko(id),
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (toko_id, key)
);
-- Seed pengaturan ada di bagian bawah (setelah toko di-INSERT) -- FK
-- toko_id butuh baris toko sudah ada duluan.

-- ==========================================================
-- 11. WEB ETALASE ONLINE — dikelola dari admin kasire (1 login, TIDAK
--     ada tabel auth terpisah lagi -- users/session kasir dipakai untuk
--     semuanya, termasuk kelola etalase).
-- ==========================================================

-- Pengaturan tampilan web etalase. 1 BARIS PER CABANG (toko_id) -- bukan
-- 1 baris tetap seperti versi sebelumnya, supaya siap deploy multi-domain
-- (1 etalase per cabang, masing-masing baca baris pengaturannya sendiri).
CREATE TABLE store_settings (
  toko_id INTEGER PRIMARY KEY REFERENCES toko(id),
  store_name TEXT NOT NULL DEFAULT 'Toko Saya',
  logo_key TEXT,
  wa_number TEXT NOT NULL DEFAULT '',
  address TEXT,
  operating_hours TEXT,
  description TEXT,
  banner_text TEXT,
  banner_image_key TEXT,
  theme TEXT NOT NULL DEFAULT 'default',
  checkout_message_template TEXT NOT NULL DEFAULT 'Halo, saya mau pesan:
{items}

Total: {total}
Nama: {nama}
Catatan: {catatan}'
);

-- Penyimpanan R2 (galeri/logo/banner etalase + foto utama produk kasir --
-- SEKARANG 1 BUCKET DIPAKAI BERSAMA, lihat wrangler.toml kedua project).
CREATE TABLE storage_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO storage_usage (id, total_bytes) VALUES (1, 0);

-- Riwayat pesanan (log checkout WhatsApp dari web toko, BUKAN transaksi
-- kasir). produk_id menunjuk ke tabel `produk` yang sama dengan kasir.
-- toko_id WAJIB diisi saat insert (dari STORE_TOKO_ID milik deployment
-- etalase yang menerima checkout ini) -- kalau deploy multi-cabang/
-- multi-domain, ini yang memisahkan riwayat pesanan antar cabang supaya
-- TIDAK TERCAMPUR (lihat ARSITEKTUR.md, bagian multi-cabang).
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  toko_id INTEGER NOT NULL REFERENCES toko(id),
  buyer_name TEXT NOT NULL,
  buyer_note TEXT,
  items_json TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_toko ON orders(toko_id, created_at);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  produk_id INTEGER REFERENCES produk(id) ON DELETE SET NULL,
  qty INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_order_items_produk ON order_items(produk_id);

-- ==========================================================
-- SEED DATA — data contoh untuk testing awal, ganti/hapus saat go-live
-- ==========================================================

INSERT INTO toko_pusat (id, nama) VALUES (1, 'Perusahaan Contoh');

INSERT INTO toko (id, toko_pusat_id, nama, alamat) VALUES (1, 1, 'Toko Pusat', 'Jl. Sudirman No. 1, Jakarta');

INSERT INTO pengaturan (toko_id, key, value) VALUES
  (1, 'app_title', 'KASIR CLOUD'),
  (1, 'struk_footer', 'Terima kasih atas kunjungan Anda'),
  (1, 'struk_catatan', ''),
  (1, 'struk_lebar_kertas', '58'),
  (1, 'struk_tampilkan_alamat', '1'),
  (1, 'struk_footer_ikon', 'tidak'),
  (1, 'struk_qr_data', '');

-- User kasir: admin / admin123 (super_admin -- toko_id NULL krn urus SEMUA
-- cabang di dalam toko_pusat_id=1, tapi TIDAK BISA lihat toko_pusat lain)
INSERT INTO users (username, password_hash, password_salt, nama_lengkap, role, toko_pusat_id, toko_id)
VALUES (
  'admin',
  '140a7aca01833a760a75db961467aca75f727d7ef1fe67e7f17200b9e6860a14',
  'TFmX3NRudck7T7kc2nXSTQ==',
  'Harvey (Admin)',
  'super_admin',
  1,
  NULL
);

-- User kasir: kasir1 / kasir123 (kasir)
INSERT INTO users (username, password_hash, password_salt, nama_lengkap, role, toko_pusat_id, toko_id)
VALUES (
  'kasir1',
  'cd908c8474284c0ce2441e079755b4f43dd1cb416f5955cbe131816f9dd82c99',
  'ZuY57TlXvVrXsZh+/82REg==',
  'Kasir Satu',
  'kasir',
  1,
  1
);

INSERT INTO kategori (id, toko_pusat_id, nama, slug, urutan) VALUES
  (1, 1, 'Makanan', 'makanan', 1),
  (2, 1, 'Minuman', 'minuman', 2);

-- Produk contoh — tampil_online = 1 supaya langsung kelihatan di web
-- toko untuk keperluan testing (matikan/atur ulang saat go-live).
INSERT INTO produk (toko_id, kategori_id, kode_produk, nama, harga_beli, harga_jual, stok, satuan, slug, deskripsi_toko, tampil_online) VALUES
  (1, 1, '899123456', 'Indomie Goreng Original', 2800, 3500, 120, 'pcs', 'indomie-goreng-original', 'Mie instan goreng favorit keluarga.', 1),
  (1, 2, '899654321', 'Kopi Kenangan Botol', 7500, 9500, 45, 'pcs', 'kopi-kenangan-botol', 'Kopi susu botolan siap minum.', 1),
  (1, 1, '899112233', 'Roti Aoka Coklat', 2000, 2500, 80, 'pcs', 'roti-aoka-coklat', 'Roti isi coklat lembut.', 1),
  (1, 2, '899445566', 'Aqua Botol 600ml', 2200, 3000, 200, 'pcs', 'aqua-botol-600ml', 'Air mineral kemasan botol 600ml.', 1),
  (1, 1, '899333222', 'Beras Ramos 5kg', 68000, 75000, 15, 'pcs', 'beras-ramos-5kg', 'Beras pulen kemasan 5kg.', 0),
  (1, 2, '899111222', 'Susu UHT 1L', 15000, 18500, 50, 'pcs', 'susu-uht-1l', 'Susu UHT full cream 1 liter.', 1);

-- store_settings SEKARANG 1 baris PER CABANG (toko_id) -- contoh di bawah
-- untuk toko_id = 1 (Toko Pusat). Kalau nanti tambah cabang baru yang mau
-- punya etalase sendiri, INSERT baris baru dengan toko_id cabang tsb
-- (lihat ARSITEKTUR.md bagian multi-cabang untuk urutan lengkapnya).
INSERT INTO store_settings (toko_id, store_name, wa_number)
VALUES (1, 'Toko Saya', '628123456789');

-- ==========================================================
-- PENTING sebelum go-live:
--   1. Ganti password default user kasir (admin/kasir1) — akun ini JUGA
--      dipakai untuk kelola etalase (1 login untuk semuanya).
--   2. Cek/ubah store_settings.toko_id sesuai cabang yang benar.
--   3. Hapus/ganti produk contoh di atas.
-- ==========================================================
