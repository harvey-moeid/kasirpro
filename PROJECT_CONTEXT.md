# PROJECT_CONTEXT.md — KasirPro
*Di-generate: 2026-08-11 | Status: SANDBOX (belum production)*

---

## 1. STACK & DEPLOYMENT

| Komponen | Teknologi |
|---|---|
| Runtime | Cloudflare Workers (Edge) |
| Framework API | Hono v4.6.x |
| Database | Cloudflare D1 (SQLite) — 1 DB shared kasire+etalase |
| Object Storage | Cloudflare R2 (foto produk, logo, banner) |
| Auth | PBKDF2-SHA256 (100k iter) + HMAC-SHA256 JWT (8 jam) |
| Frontend | Vanilla HTML/JS/CSS (Tailwind CSS v3) |
| PWA | Service Worker v23, manifest, offline queue |
| TypeScript | v5.6.x |
| Wrangler | v4.110.x |

**Topologi:**
```
domainanda.com/          → Worker: etalase   (publik, read-only)
domainanda.com/kasir/*   → Worker: kasire    (kasir + admin panel)
```
Keduanya share 1 D1 database (`kasirpro`, id: `8c615557-4b54-4014-ab9d-c5a2390acf7d`) dan 1 R2 bucket (`kasirpro`).

---

## 2. STRUKTUR FOLDER

```
kasirpro/
├── ARSITEKTUR.md           — desain arsitektur & keputusan teknis
├── ARSITEKTUR.md           — desain arsitektur & keputusan teknis
├── PROSES.md               — catatan proses development
├── DEPLOY.md / DEPLOY-BARU.md — panduan deploy
├── kasire/                 — Worker kasir + admin
│   ├── src/
│   │   ├── index.ts        — SEMUA route API (2842 baris) + fetch() handler
│   │   └── lib/
│   │       ├── auth-middleware.ts  — requireAuth, requireRole, AppEnv type
│   │       └── crypto.ts           — hashPassword, verifyPassword, signToken, verifyToken
│   ├── public/
│   │   ├── index.html      — Halaman kasir (3215 baris, PWA)
│   │   ├── admin.html      — Panel admin (2873 baris)
│   │   ├── login.html      — Halaman login
│   │   ├── sw.js           — Service Worker (cache-first, offline queue)
│   │   ├── manifest.json   — PWA manifest
│   │   └── styles.css      — Tailwind compiled output
│   ├── migrations/
│   │   ├── 0001_init.sql   — Skema lengkap + seed data
│   │   └── 0002_login_ratelimit.sql — failed_attempts, locked_until
│   └── wrangler.toml
└── etalase/                — Worker storefront publik
    ├── src/
    │   ├── index.ts        — Route aggregator (publik: produk, kategori, settings, orders, images)
    │   ├── types.ts        — Env, Variables, Product, Category, StoreSettings interfaces
    │   ├── lib/produk.ts   — toPublicProduct() helper
    │   └── routes/
    │       ├── products.ts — GET /api/products, GET /api/products/:id
    │       ├── categories.ts — GET /api/categories
    │       ├── settings.ts   — GET /api/settings
    │       ├── orders.ts     — POST /api/orders (log checkout WA)
    │       └── images.ts     — GET /images/:key (proxy R2)
    ├── public/
    │   └── index.html      — Storefront frontend (163 baris)
    ├── migrations/
    │   └── 0001_init.sql   — Pointer ke shared schema (sama dengan kasire)
    └── wrangler.toml
```

---

## 3. SKEMA DATABASE

**Migration terakhir: `0003_fixes.sql`** *(fix slug index global → per toko_id)*

### Tabel Utama

```sql
-- TENANT (1 baris = 1 bisnis/pelanggan berbeda)
toko_pusat (id, nama, created_at)

-- CABANG (1+ per tenant)
toko (id, toko_pusat_id FK, nama, alamat, created_at)

-- USERS
users (
  id, username UNIQUE, password_hash, password_salt,
  nama_lengkap, role CHECK('super_admin'|'admin_toko'|'kasir'),
  toko_pusat_id FK,   -- isolasi TENANT
  toko_id FK NULL,    -- NULL untuk super_admin
  is_active DEFAULT 1,
  hidden_tabs TEXT,   -- JSON array tab tersembunyi (preferensi individu)
  created_at,
  -- dari migration 0002:
  failed_attempts INTEGER DEFAULT 0,
  locked_until TEXT NULL
)

-- KATEGORI (shared per tenant, bukan per cabang)
kategori (id, toko_pusat_id FK, nama, slug, urutan DEFAULT 0)
UNIQUE INDEX (toko_pusat_id, slug) WHERE slug IS NOT NULL

-- PRODUK (per cabang, shared kasir+etalase)
produk (
  id, toko_id FK, kategori_id FK NULL,
  kode_produk UNIQUE, nama,
  harga_beli REAL DEFAULT 0, harga_jual REAL NOT NULL,
  stok INTEGER DEFAULT 0, satuan DEFAULT 'pcs',
  gambar_url TEXT, is_active DEFAULT 1,
  -- kolom etalase:
  slug TEXT UNIQUE, deskripsi_toko TEXT,
  harga_coret REAL, tampil_online DEFAULT 0, urutan_tampil DEFAULT 0,
  created_at, updated_at
)

-- GALERI FOTO (storefront)
produk_galeri (id, produk_id FK CASCADE, image_key, urutan DEFAULT 0)

-- SHIFT KASIR
shift_kasir (
  id, kasir_id FK, toko_id FK,
  modal_awal REAL NOT NULL,
  kas_sistem_akhir REAL, kas_fisik_akhir REAL, selisih REAL, catatan TEXT,
  status CHECK('buka'|'tutup') DEFAULT 'buka',
  waktu_buka, waktu_tutup
)

-- TRANSAKSI
transaksi (
  id, kode_transaksi UNIQUE, toko_id FK, kasir_id FK, shift_id FK NULL,
  total_belanja REAL, diskon REAL DEFAULT 0, pajak REAL DEFAULT 0,
  total_bayar REAL,
  metode_bayar CHECK('cash'|'transfer'|'qris'|'debit'|'split'),
  uang_diterima REAL, kembalian REAL DEFAULT 0,
  status CHECK('selesai'|'dibatalkan') DEFAULT 'selesai',
  offline_uuid TEXT UNIQUE,
  created_at
)

-- SPLIT PAYMENT DETAIL
transaksi_pembayaran (id, transaksi_id FK, metode_bayar, jumlah)

-- DETAIL ITEM TRANSAKSI
detail_transaksi (
  id, transaksi_id FK, produk_id FK NULL, nama_produk, harga_satuan, qty,
  subtotal, hpp_satuan,  -- snapshot HPP saat transaksi
  diskon_item DEFAULT 0,
  qty_retur DEFAULT 0, subtotal_retur DEFAULT 0  -- akumulasi retur sebagian
)

-- RIWAYAT STOK
riwayat_stok (
  id, produk_id FK,
  jenis CHECK('masuk'|'keluar'|'koreksi'),
  jumlah, stok_sebelum, stok_sesudah, referensi TEXT, user_id FK,
  created_at
)

-- RETUR
retur (id, transaksi_id FK, toko_id FK, user_id FK, total_retur REAL,
       alasan TEXT, metode_pengembalian CHECK('cash'|'non_cash'), created_at)
retur_item (id, retur_id FK, detail_transaksi_id FK, produk_id FK,
            nama_produk, qty, subtotal)

-- AUDIT TRAIL
log_aktivitas (
  id, user_id FK NULL, username, toko_id FK NULL,
  aksi, entitas, entitas_id INTEGER, keterangan, created_at
)

-- PENGATURAN (per cabang)
pengaturan (toko_id FK, key TEXT, value TEXT, updated_at)
PRIMARY KEY (toko_id, key)
-- Keys: app_title, struk_footer, struk_catatan, struk_lebar_kertas,
--       struk_tampilkan_alamat, struk_footer_ikon, struk_qr_data,
--       admin_tabs_enabled

-- ETALASE SETTINGS (per cabang)
store_settings (
  toko_id PK FK, store_name, logo_key, wa_number, address,
  operating_hours, description, banner_text, banner_image_key,
  theme DEFAULT 'default', checkout_message_template
)

-- STORAGE USAGE (tidak aktif dipakai — dead table)
storage_usage (id PK CHECK(id=1), total_bytes DEFAULT 0)

-- ONLINE ORDERS (log checkout WA, bukan transaksi kasir)
orders (id, toko_id FK, buyer_name, buyer_note, items_json, total, created_at)
order_items (id, order_id FK CASCADE, produk_id FK NULL SET NULL, qty)
```

---

## 4. SEMUA ENDPOINT API — kasire (backend)

### Auth
| Method | Path | Role | Keterangan |
|---|---|---|---|
| POST | /api/auth/login | - | Login, rate limit 5x→lock 15 menit |
| POST | /api/auth/logout | - | Hapus cookie sesi |
| GET | /api/auth/me | auth | Info sesi + hidden_tabs |
| PUT | /api/auth/me/tabs | auth | Update hidden_tabs individu |
| POST | /api/auth/change-password | auth | Ganti password (perlu password lama) |

### Settings & Tabs
| Method | Path | Role | Keterangan |
|---|---|---|---|
| GET | /api/settings | public (soft-auth) | Pengaturan app per cabang |
| PUT | /api/settings | super_admin, admin_toko | Update pengaturan |
| GET | /api/settings/tabs-cabang | auth | Tab diaktifkan per cabang |
| PUT | /api/settings/tabs-cabang | super_admin | Set kebijakan tab per cabang |

### Produk
| Method | Path | Role | Keterangan |
|---|---|---|---|
| GET | /api/produk | auth | List produk aktif |
| POST | /api/produk | super_admin, admin_toko | Tambah produk (limit 200/tenant) |
| PUT | /api/produk/:id | super_admin, admin_toko | Edit produk |
| DELETE | /api/produk/:id | super_admin, admin_toko | Soft-delete (is_active=0) |
| POST | /api/produk/:id/koreksi-stok | super_admin, admin_toko | Koreksi stok manual |
| GET | /api/produk/:id/galeri | auth | List foto galeri |
| POST | /api/produk/:id/galeri | super_admin, admin_toko | Upload foto galeri |
| DELETE | /api/produk/:id/galeri/:galeriId | super_admin, admin_toko | Hapus foto galeri |

### Upload & Gambar
| Method | Path | Role | Keterangan |
|---|---|---|---|
| POST | /api/upload/produk | super_admin, admin_toko | Upload foto utama produk ke R2 |
| POST | /api/upload/etalase | super_admin, admin_toko | Upload logo/banner ke R2 |
| GET | /api/gambar/* | public | Serve foto dari R2 (immutable cache) |

### Toko & Kategori
| Method | Path | Role | Keterangan |
|---|---|---|---|
| GET | /api/toko | auth | List cabang tenant |
| POST | /api/toko | super_admin | Tambah cabang |
| PUT | /api/toko/:id | super_admin | Edit nama/alamat cabang |
| GET | /api/kategori | auth | List kategori tenant |
| POST | /api/kategori | super_admin, admin_toko | Tambah kategori |
| PUT | /api/kategori/:id | super_admin, admin_toko | Edit kategori |
| DELETE | /api/kategori/:id | super_admin, admin_toko | Hapus kategori |

### Etalase (dikelola dari kasire)
| Method | Path | Role | Keterangan |
|---|---|---|---|
| GET | /api/etalase/settings | auth | Baca store_settings |
| PUT | /api/etalase/settings | super_admin, admin_toko | Update store_settings |
| GET | /api/etalase/orders | auth | Riwayat pesanan WA |

### Shift
| Method | Path | Role | Keterangan |
|---|---|---|---|
| POST | /api/shift/buka | auth | Buka shift (1 shift aktif/kasir) |
| GET | /api/shift/aktif | auth | Shift aktif + rekap kas |
| POST | /api/shift/tutup | auth | Tutup shift + hitung selisih |
| GET | /api/shift | super_admin, admin_toko | Riwayat shift |

### Transaksi
| Method | Path | Role | Keterangan |
|---|---|---|---|
| POST | /api/transaksi | auth | Buat transaksi (atomic batch, retry kode collision) |
| GET | /api/transaksi | auth | List transaksi (default limit 500, max 5000) |
| GET | /api/transaksi/:id | auth | Detail transaksi + items + pembayaran + retur |
| POST | /api/transaksi/:id/batalkan | super_admin, admin_toko | Batalkan + kembalikan stok |
| POST | /api/transaksi/:id/retur | auth (kasir perlu confirm_password) | Retur sebagian item |

### Laporan
| Method | Path | Role | Keterangan |
|---|---|---|---|
| GET | /api/laporan/harian | auth | Ringkasan omzet per tanggal |
| GET | /api/laporan/produk-terlaris | auth | Top produk (limit + range tanggal) |
| GET | /api/laporan/laba | auth | Laba kotor per produk (hpp snapshot) |
| GET | /api/laporan/tren-penjualan | auth | Tren harian N hari (isi tanggal kosong=0) |
| GET | /api/laporan/stok-menipis | auth | Produk stok ≤ ambang |

### Users & Admin
| Method | Path | Role | Keterangan |
|---|---|---|---|
| GET | /api/users | super_admin, admin_toko | List users + status shift aktif |
| POST | /api/users | super_admin, admin_toko | Tambah user |
| PUT | /api/users/:id | super_admin, admin_toko | Edit user (nama, is_active, password) |
| GET | /api/log-aktivitas | super_admin, admin_toko | Audit trail admin (limit 300) |
| POST | /api/admin/reset-data | super_admin, admin_toko | Reset data toko (destruktif, konfirmasi frasa) |

### Endpoint Etalase (Worker etalase, publik semua)
| Method | Path | Keterangan |
|---|---|---|
| GET | /api/products | List produk online (filter: q, category, include_sold_out) |
| GET | /api/products/:id | Detail produk + galeri |
| GET | /api/categories | List kategori |
| GET | /api/settings | Info toko (nama, wa_number, dll) |
| POST | /api/orders | Log checkout WA (validasi produk_id ke STORE_TOKO_ID) |
| GET | /images/* | Serve foto R2 (cache 1 hari) |
| GET | /api/health | Health check |

---

## 5. FITUR STATUS

| Fitur | Status |
|---|---|
| Auth (login/logout/me/change-password) | ✅ Selesai |
| Rate limiting login (5 percobaan → lock 15 menit) | ✅ Selesai |
| Multi-tenant isolation (toko_pusat_id) | ✅ Selesai |
| CRUD Produk + soft-delete | ✅ Selesai |
| Upload foto R2 + kuota per-tenant (500MB) | ✅ Selesai |
| Galeri foto per produk (max 10) | ✅ Selesai |
| Kategori (CRUD, slug, urutan) | ✅ Selesai |
| Shift kasir (buka/tutup/rekap kas) | ✅ Selesai |
| Transaksi (atomic, split payment, offline_uuid) | ✅ Selesai |
| Transaksi: diskon per-item + diskon total | ✅ Selesai |
| Transaksi: retry kode_transaksi collision | ✅ Selesai |
| Pembatalan transaksi + kembalikan stok | ✅ Selesai |
| Retur sebagian (partial retur, confirm password kasir) | ✅ Selesai |
| Laporan harian / terlaris / laba / tren / stok menipis | ✅ Selesai |
| Laporan: harga diambil dari hpp_satuan (snapshot) | ✅ Selesai |
| Audit trail log_aktivitas | ✅ Selesai |
| Reset data toko (destruktif, konfirmasi frasa) | ✅ Selesai |
| Etalase publik (produk, kategori, settings, orders) | ✅ Selesai |
| Etalase: checkout log WA + order_items sold_count | ✅ Selesai |
| Kelola etalase dari admin kasire (1 login) | ✅ Selesai |
| Path-based mount /kasir + prefix stripping | ✅ Selesai |
| PWA + Service Worker + offline queue | ✅ Selesai |
| Geo-restriction (ENFORCE_GEO) | ✅ Selesai |
| CORS (ALLOWED_ORIGIN env var) | ✅ Selesai (ada bug wrangler.toml — lihat §7) |
| Multi-cabang (super_admin kelola semua) | ✅ Selesai |
| Aksesibilitas WCAG AA (login, index, admin) | ✅ Selesai (commit terakhir) |
| Export Excel laporan | 🔲 Frontend (admin.html) ada; limit bisa diset via ?limit= |

---

## 6. KEPUTUSAN DESAIN PENTING

1. **1 DB dipakai bersama kasire+etalase** — produk/stok selalu real-time tanpa sync.
2. **Harga transaksi selalu dari DB** (bukan body client) — cegah price manipulation.
3. **HPP di-snapshot per baris detail_transaksi** — laba historis tidak berubah walau harga beli produk diubah kemudian.
4. **Stok bisa negatif** (offline sync terlambat diterima) — diterima by design, direkonsiliasi via laporan.
5. **kode_transaksi: 6 digit acak + retry** — cukup untuk mencegah collision birthday-paradox sampai ~2000 transaksi/hari/toko.
6. **Kuota R2 per-tenant (bukan per-bucket)** — tenant yang penuh tidak hambat tenant lain.
7. **Retur kasir wajib confirm_password** — re-autentikasi identitas, bukan persetujuan atasan.
8. **Cookie path adaptif** — `/kasir` saat path-based mount, `/` saat akses *.workers.dev langsung.
9. **Kategori shared per-tenant** (bukan per-cabang) — lebih praktis untuk multi-cabang 1 bisnis.
10. **Waktu semua di WIB** (UTC+7 hardcode) — sesuai geo-restriction Indonesia-only.

---

## 7. BUG DITEMUKAN & STATUS PERBAIKAN

### ✅ SUDAH DIPERBAIKI

**B1 — Cross-tenant transaction oleh super_admin** *(kritis — fix 2026-08-12)*
- File: `kasire/src/routes/transaksi.ts`
- Root cause: `const toko_id = session.toko_id ?? body.toko_id;` — body.toko_id tidak divalidasi kepemilikan tenant.
- Fix: Gunakan `validasiTokoIdMilikTenant(db, session, body.toko_id)` untuk super_admin, return 400 jika toko_id bukan milik tenant yang sama.

**B2 — TOML inline comment masuk ke nilai string ALLOWED_ORIGIN** *(sedang — fix sebelumnya)*
- File: `kasire/wrangler.toml`
- Fix: ALLOWED_ORIGIN diganti domain real tanpa inline comment.

**B3 — stok-menipis ekspos harga_beli ke role kasir** *(sedang — fix 2026-08-12)*
- File: `kasire/src/routes/transaksi.ts`, `GET /api/laporan/stok-menipis`
- Fix: `SELECT p.*` diganti kolom eksplisit; `harga_beli` hanya disertakan jika `session.role !== 'kasir'`.

**B5 — Retur: dua `db.batch()` terpisah (non-atomic)** *(minor — fix 2026-08-12)*
- File: `kasire/src/routes/transaksi.ts`, `POST /:id/retur`
- Fix: INSERT retur via `.run()` dulu untuk dapat `last_row_id`, lalu semua operasi sisanya (UPDATE stok/detail + INSERT retur_item) dalam **1 batch atomic**.

**B6 — Slug produk UNIQUE global, bukan per-tenant** *(kritis — fix 2026-08-13)*
- File: `kasire/migrations/0003_fixes.sql`
- Root cause: `CREATE UNIQUE INDEX idx_produk_slug ON produk(slug)` → global lintas semua tenant. Slug 'kopi-susu' di Tenant A langsung bentrok dengan Tenant B.
- Fix: DROP index lama, CREATE UNIQUE INDEX `idx_produk_slug_per_toko ON produk(toko_id, slug)`. Dalam 1 toko tetap unik, beda toko boleh sama.

**B7 — Log aktivitas super_admin tidak pernah muncul** *(sedang — fix 2026-08-13)*
- File: `kasire/src/routes/admin.ts`, `GET /api/log-aktivitas`
- Root cause: `WHERE toko_id IN (SELECT id FROM toko ...)` — `NULL` tidak pernah cocok dengan `IN`, sehingga log aksi super_admin (toko_id=NULL) selalu hilang.
- Fix: Query dipisah per-role. Super_admin: `toko_id IN (...)` OR `(toko_id IS NULL AND user_id IN (SELECT id FROM users WHERE toko_pusat_id = ?))`.

**B8 — Reset data tidak hapus orders & order_items** *(sedang — fix 2026-08-13)*
- File: `kasire/src/routes/admin.ts`, `POST /api/admin/reset-data`
- Root cause: Batch DELETE tidak menyertakan tabel `orders`/`order_items`. Setelah reset, riwayat pesanan WA masih ada, `order_items` masih ada → `sold_count` storefront kacau.
- Fix: Tambah 2 DELETE ke batch (`order_items` dulu karena child, baru `orders`).

**B9 — Asimetri sync nama toko** *(minor — fix 2026-08-13)*
- File: `kasire/src/routes/admin.ts`, `PUT /api/etalase/settings`
- Root cause: `PUT /api/toko/:id` sudah sync `toko.nama → store_settings.store_name`, tapi `PUT /api/etalase/settings` tidak sync balik `store_settings.store_name → toko.nama`. Dua field bisa diverge.
- Fix: Batch tambah `UPDATE toko SET nama = ?` saat `store_name` dikirim (tidak kosong).

**B10 — Laporan laba bisa diakses role kasir** *(sedang — fix 2026-08-13)*
- File: `kasire/src/routes/transaksi.ts`, `GET /api/laporan/laba`
- Root cause: Tidak ada `requireRole` guard — kasir bisa lihat HPP (harga modal) semua produk.
- Fix: Tambah `requireRole('super_admin', 'admin_toko')`.

### 🟡 BUG MINOR (belum diperbaiki, dampak nol)

**B4 — `storage_usage` tabel tidak pernah ditulis (dead table)**
- File: `kasire/migrations/0001_init.sql`
- Masalah: Tabel dibuat & di-seed tapi kode menghitung kuota via `hitungTotalUkuranR2` (list R2 langsung). Tabel jadi dead weight.
- Dampak: Nol (tidak mempengaruhi fungsionalitas). Bisa dihapus di migration berikutnya.

---

## 8. ENV VARS YANG PERLU DISET

### kasire
```
# .dev.vars (lokal, jangan commit):
JWT_SECRET=<string panjang acak>

# wrangler.toml [vars] (non-rahasia):
ALLOWED_ORIGIN=https://domainanda.com   # tanpa komentar inline!
ENFORCE_GEO=false                       # set true saat production
```

### etalase
```
# wrangler.toml [vars]:
STORE_TOKO_ID=1        # toko_id cabang yang ditampilkan di storefront
ENVIRONMENT=production
```

### Shared secrets (via `wrangler secret put`):
- `kasire`: `JWT_SECRET`

---

## 9. SEED DATA DEFAULT (go-live: wajib ganti/hapus)

- **User admin**: `admin` / `admin123` (super_admin, toko_pusat_id=1)
- **User kasir**: `kasir1` / `kasir123` (kasir, toko_id=1)
- **Toko**: "Toko Pusat" (id=1)
- **Toko pusat**: "Perusahaan Contoh" (id=1)
- **Produk contoh**: 6 produk (Indomie, Kopi Kenangan, dll — `tampil_online=1`)
- **store_settings**: wa_number=628123456789

**Sebelum go-live:**
1. Ganti semua password default
2. Hapus/ganti produk contoh
3. Update ALLOWED_ORIGIN dan ENFORCE_GEO
4. ✅ B1/B3/B5 sudah diperbaiki (2026-08-12)
5. ✅ B6/B7/B8/B9/B10 sudah diperbaiki (2026-08-13) — jalankan migration 0003 sebelum deploy
6. B4 dead table, dampak nol (bisa diabaikan)
