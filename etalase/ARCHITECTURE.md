> ⚠️ **CATATAN:** Dokumen ini ditulis untuk arsitektur LAMA (database `toko` terpisah). Sejak database digabung dengan kasir, sebagian info di sini (nama database, tabel `products`/`categories`) sudah usang. Baca `ARSITEKTUR.md` di root folder terlebih dahulu.

# Arsitektur — Toko (Etalase WA)

Dokumen ini peta lengkap project: apa yang ada, di mana letaknya, dan bagaimana semua bagian terhubung. Ditulis Juli 2026 setelah fase pengembangan fitur cepat — dipakai sebagai referensi sebelum nambah/ubah apapun ke depannya.

---

## 1. Gambaran Umum

**Apa ini:** Etalase produk berbasis web, checkout lewat WhatsApp (bukan payment gateway). Ada 3 pilihan tema tampilan (Default/Shopee/TikTokShop). Admin kelola produk/kategori/pesanan lewat panel terpisah.

**Stack:**
- **Runtime:** Cloudflare Workers (edge, serverless)
- **Framework:** [Hono](https://hono.dev) (router ringan, mirip Express)
- **Database:** Cloudflare D1 (SQLite)
- **Storage gambar:** Cloudflare R2
- **Frontend:** Vanilla HTML/CSS/JS — **tidak ada framework** (tidak React/Vue), tidak ada build step, tidak ada bundler
- **Bahasa:** TypeScript untuk backend (`src/`), plain JS untuk frontend (`public/`)

**Kenapa arsitektur ini:** Semua di satu Worker, tidak perlu server terpisah, biaya hosting nyaris nol untuk skala toko kecil-menengah (free tier Cloudflare cukup untuk ribuan request/hari).

---

## 2. Struktur Folder

```
toko-main/
├── src/                       # Backend (TypeScript, jalan di Cloudflare Worker)
│   ├── index.ts               # Entry point, mount semua route ke /api/*
│   ├── types.ts                # Tipe Env (bindings) & Variables (context)
│   ├── middleware/
│   │   └── auth.ts             # requireAdmin — cek session cookie
│   ├── lib/
│   │   ├── password.ts         # Hash & verifikasi password (PBKDF2)
│   │   ├── rateLimit.ts        # Rate limiting brute-force (login & ganti password)
│   │   └── limits.ts           # Limit storage 500MB & 200 produk, tracking usage R2
│   └── routes/
│       ├── auth.ts             # Login, logout, ganti password, kelola multi-admin
│       ├── products.ts         # CRUD produk + galeri foto + sold_count
│       ├── categories.ts       # CRUD kategori
│       ├── settings.ts         # Pengaturan toko (nama, WA, tema, banner, dst)
│       ├── orders.ts           # Log riwayat pesanan (dari checkout WA)
│       ├── upload.ts           # Upload gambar ke R2, cek kuota storage
│       └── images.ts           # Serve gambar dari R2 (publik, /images/*)
│
├── public/                    # Frontend (di-serve langsung sebagai static assets)
│   ├── index.html              # Storefront (halaman utama, publik)
│   ├── js/
│   │   ├── storefront.js       # Semua logic storefront (render produk, cart, checkout, dst)
│   │   └── cart.js             # State keranjang (localStorage-backed)
│   ├── css/
│   │   ├── style.css           # Style storefront + definisi 3 tema (default/shopee/tiktokshop)
│   │   └── admin.css           # Style admin panel (import style.css juga)
│   └── admin/
│       ├── login.html          # Halaman login admin
│       ├── index.html          # Dashboard admin (semua tab dalam 1 halaman)
│       └── js/admin.js         # Semua logic admin panel
│
├── migrations/                # Migrasi database bernomor (WAJIB baca §4 sebelum ubah)
│   └── 0001_initial.sql ... 0009_product_images.sql
│
├── schema.sql                  # REFERENSI SAJA — snapshot skema final, TIDAK dieksekusi
├── scripts/seed-admin.mjs      # CLI buat akun admin pertama
├── wrangler.toml                # Konfigurasi Cloudflare (binding DB/R2, compatibility_date)
├── package.json                 # Script npm (dev, deploy, migrate, seed-admin)
├── README.md                    # Setup awal dari nol
└── deploy.md                    # Panduan deploy & troubleshooting rutin
```

---

## 3. Skema Database (D1)

Singkatan FK: `→` = foreign key ke tabel lain.

| Tabel | Kolom penting | Keterangan |
|---|---|---|
| `categories` | `name`, `slug`, `sort_order` | Kategori produk |
| `products` | `name`, `price`, `original_price`, `category_id → categories`, `image_key`, `status` | `original_price` = harga sebelum diskon (nullable). `status`: `available`\|`sold_out` |
| `product_images` | `product_id → products` (CASCADE), `image_key`, `sort_order` | Galeri foto tambahan (di luar `image_key` utama/cover) |
| `store_settings` | `store_name`, `wa_number`, `theme`, `banner_text`, `banner_image_key`, `checkout_message_template` | Singleton (`id=1` selalu, cuma 1 baris) |
| `admin_users` | `username`, `password_hash` | Multi-admin didukung |
| `admin_sessions` | `token`, `admin_id → admin_users` (CASCADE), `expires_at` | Token random 32-byte hex, TTL 7 hari |
| `login_attempts` | `key`, `attempt_count`, `locked_until` | Rate limit brute-force (key = `login:username:ip` atau `changepw:...`) |
| `orders` | `buyer_name`, `items_json`, `total`, `created_at` | Log checkout — **bukan** sistem status pesanan, cuma riwayat |
| `order_items` | `order_id → orders` (CASCADE), `product_id → products` (SET NULL), `qty` | Link tiap item order ke produk, buat hitung `sold_count` |
| `storage_usage` | `total_bytes` | Singleton (`id=1`), counter manual total ukuran file R2 |

**Relasi kunci:**
- `products.category_id → categories.id` — kalau kategori dihapus, `category_id` jadi NULL (produk tidak terhapus)
- `product_images.product_id → products.id` — kalau produk dihapus, baris galeri ikut terhapus (CASCADE), tapi **file di R2 harus dihapus manual** (lihat §5.2)
- `order_items.product_id → products.id` — kalau produk dihapus, `product_id` jadi NULL, **baris order_items tetap ada** (riwayat transaksi tidak boleh hilang meski produknya sudah tidak ada)

---

## 4. Sistem Migrasi

**Command:** `npm run db:migrate:local` / `db:migrate:remote` → menjalankan `wrangler d1 migrations apply`.

**Cara kerja:** Setiap file di `migrations/000N_nama.sql` dilacak di tabel `d1_migrations` (dibuat otomatis oleh Wrangler). File yang sudah pernah jalan **tidak akan diulang**, jadi command ini aman dijalankan berkali-kali kapan saja.

**⚠️ Aturan wajib:**
1. **Jangan pernah edit file migrasi yang sudah ada** — buat file baru: `npx wrangler d1 migrations create toko nama_perubahan`
2. Kolom baru di tabel yang **sudah ada** → pakai `ALTER TABLE ... ADD COLUMN` (bukan edit `CREATE TABLE` di file lama — itu tidak akan pernah jalan karena `CREATE TABLE IF NOT EXISTS` di-skip kalau tabel sudah ada). Ini pernah jadi bug nyata (lihat §7).
3. `schema.sql` di root **hanya dokumentasi**, tidak pernah dieksekusi langsung. Boleh diupdate sekadar biar sinkron, tapi migrasi asli selalu di `migrations/`.

---

## 5. Alur Data Penting

### 5.1 Checkout (storefront → WA)
1. Pembeli isi keranjang (`cart.js`, disimpan di `localStorage`, tidak ada di server)
2. Klik "Pesan via WhatsApp" → `storefront.js`:
   - POST `/api/orders` (fire-and-forget, log riwayat — kalau gagal/offline, checkout tetap lanjut)
   - Buka `wa.me/<nomor>?text=<pesan>` di tab baru
3. `orders.ts` simpan ke `orders` (snapshot harga saat itu) + `order_items` (link ke `product_id` buat `sold_count`)

### 5.2 Upload gambar & tracking storage
Semua gambar (produk, galeri, logo, banner) lewat endpoint yang sama: `POST /api/upload`.

1. Client (`admin.js`) kompres gambar dulu di browser (canvas resize, maks 1280px, JPEG 82%) sebelum kirim
2. Server (`upload.ts`) validasi magic bytes (bukan cuma percaya `Content-Type` dari client), cek kuota (`getStorageUsage() + fileSize > 500MB` → tolak)
3. Simpan ke R2, `addStorageUsage()` nambah counter di `storage_usage`

**Penting — kapan gambar lama harus dihapus manual dari R2** (bug ini pernah ada, sudah dibenerin, JANGAN diulang):
- Ganti foto produk/logo/banner → PUT/settings handler cek `old_key !== new_key`, kalau beda panggil `deleteImageAndTrack()`
- Hapus produk → semua foto (cover + galeri) dihapus dari R2 sebelum row dihapus dari DB
- Kalau nambah field gambar baru di masa depan: **selalu** ikuti pola ini (cek lama vs baru, hapus yang tidak dipakai lagi), jangan cuma overwrite pointer di DB

**Kalau counter `storage_usage` dicurigai meleset:** `POST /api/upload/recalculate` (admin) — hitung ulang dari isi R2 asli (sumber kebenaran), bukan dari counter.

### 5.3 Autentikasi admin
- Login → `admin_sessions` (token random, bukan JWT — desain sengaja, lebih simpel untuk single-app-instance dan bisa di-revoke langsung dari DB)
- Cookie `HttpOnly` + `Secure`, `SameSite=Lax`
- `requireAdmin` middleware cek token di setiap request ke endpoint admin, set `adminId`/`adminUsername` di context
- Ganti password → cabut semua sesi *lain* (device yang dipakai ganti password tetap login)
- Rate limit: 5x gagal / 15 menit → lock 15 menit, per kombinasi `username+IP`

### 5.4 Sistem Tema
Storefront baca `settings.theme` (`default`/`shopee`/`tiktokshop`) → JS set `document.documentElement.dataset.theme` → CSS `[data-theme="..."]` override **CSS variable** (warna, radius, gradient), bukan file CSS terpisah per tema. Satu `style.css` untuk semua tema.

Kalau nambah tema baru: cari blok `[data-theme="shopee"] { ... }` di `style.css`, duplikasi pola yang sama dengan variable baru.

### 5.5 Riwayat pesanan → "X terjual"
`order_items.product_id` + `SUM(qty)` (subquery per produk di `products.ts`) → `sold_count` di response API produk. **Ini data asli dari transaksi**, bukan angka dibuat-buat — kalau nanti mau tampilkan metrik serupa (rating, dll), pertahankan prinsip ini, jangan pakai data palsu.

---

## 6. Keamanan (ringkasan)

| Lapisan | Implementasi |
|---|---|
| Password | PBKDF2-SHA256, 100rb iterasi, salt per-user |
| Session | Token random di DB (bukan JWT), `HttpOnly`+`Secure` cookie, TTL 7 hari |
| Rate limiting | Login & ganti password, 5x/15menit lalu lock |
| Upload | Magic-byte validation (bukan cuma MIME dari client), limit 5MB/file, limit 500MB total |
| SQL | Semua query parameterized (`?` bind), tidak ada string interpolation |
| XSS | Semua `innerHTML` di frontend lewat `escapeHtml()` |
| Endpoint admin | Semua `POST`/`PUT`/`PATCH`/`DELETE` sensitif pakai `requireAdmin` middleware |

---

## 7. Bug yang Pernah Ada & Sudah Dibenerin (jangan diulang)

1. **Migrasi kolom baru tidak ke-apply ke DB production yang sudah ada** — karena awalnya pakai 1 file `schema.sql` dengan `CREATE TABLE IF NOT EXISTS` yang di-skip kalau tabel sudah ada. Fix: sistem migrasi bernomor (§4).
2. **Foto lama tidak terhapus dari R2 saat diganti** — storage bocor pelan-pelan. Fix: `deleteImageAndTrack()` dipanggil setiap ada penggantian/penghapusan gambar (§5.2).
3. **`instanceof File` gagal type-check** — karena `tsconfig.json` load versi `@cloudflare/workers-types` yang salah (default/lama). Fix: pin ke `@cloudflare/workers-types/latest`.
4. **Nama database D1 tidak konsisten** antara `wrangler.toml` (`toko`) dan script seed (`etalase-toko-db` — sisa rename lama). Fix: disamakan semua ke `toko`.

---

## 8. Fitur yang Sudah Ada (checklist referensi cepat)

**Storefront (publik):**
- Katalog produk: search, filter kategori, sort (terbaru/termurah/termahal/nama)
- Produk habis otomatis tersembunyi (tidak ada toggle)
- Harga diskon (dicoret + badge %), badge "X terjual" (data asli)
- Galeri multi-foto per produk (swipe + dot indicator)
- Share produk individual ke WA (Web Share API / fallback `wa.me`)
- Banner promo (teks atau gambar) di atas storefront
- Sticky cart bar + bottom nav bar (Beranda/Kategori/Keranjang/Toko)
- Modal info toko (nama, jam, alamat, deskripsi, tombol WA)
- Cart: tambah/kurang qty, hapus semua (konfirmasi ketuk-2x)
- Checkout → log ke `orders` + buka WA
- 3 pilihan tema (Default/Shopee/TikTokShop)

**Admin panel:**
- CRUD produk (+ galeri foto, harga diskon), kategori
- Multi-admin (tambah/hapus akun, tidak bisa hapus diri sendiri/admin terakhir)
- Ganti password (dengan show/hide, cabut sesi lain)
- Pengaturan toko: nama, WA, alamat, jam, deskripsi, banner, tema, template pesan checkout
- Riwayat pesanan (read-only log)
- Limit fixed: 500MB storage, 200 produk (pesan error kalau kena limit)

**Backend/infra:**
- Rate limiting brute-force
- Kompresi gambar client-side sebelum upload
- Validasi magic-byte untuk upload
- Sistem migrasi database bernomor & aman di-rerun

---

## 9. Yang BELUM Ada (kalau relevan untuk keputusan fitur ke depan)

- Tidak ada test otomatis (unit/integration) — semua verifikasi manual (type-check + query manual + kadang `wrangler dev` end-to-end)
- Tidak ada sistem akun/login untuk pembeli (keranjang cuma `localStorage`, hilang kalau ganti device/browser)
- Tidak ada payment gateway — checkout selalu manual lewat chat WA
- Tidak ada notifikasi (email/push) ke admin saat ada order baru — admin harus buka panel manual
- Limit storage/produk **fixed di kode**, bukan per-tenant/configurable (relevan kalau nanti mau jadi produk SaaS multi-toko)
