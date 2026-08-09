> ⚠️ **CATATAN:** Dokumen ini ditulis untuk arsitektur LAMA (database `toko` terpisah). Sejak database digabung dengan kasir, sebagian info di sini (nama database, tabel `products`/`categories`) sudah usang. Baca `ARSITEKTUR.md` di root folder terlebih dahulu.

# Etalase Toko WA (Cloudflare Workers + Hono + D1 + R2)

Webapp katalog produk toko dengan checkout otomatis via WhatsApp. Full di atas Cloudflare, tanpa server/provider lain.

📖 **Dokumentasi lengkap:**
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — peta lengkap project: skema database, semua endpoint API, alur data, fitur yang sudah ada. **Baca ini dulu** sebelum nambah/ubah fitur.
- [`deploy.md`](./deploy.md) — panduan deploy rutin & troubleshooting.

## Struktur Project
```
etalase-toko-wa/
├── src/                    # Backend (Hono, jalan di Cloudflare Workers)
│   ├── index.ts            # Entry point, routing utama
│   ├── routes/              # auth, products, categories, settings, upload, images
│   ├── middleware/auth.ts   # Guard session admin
│   └── lib/password.ts      # Hash password (PBKDF2 via Web Crypto, tanpa lib eksternal)
├── public/                 # Frontend statis (vanilla JS, di-serve via Workers Assets)
│   ├── index.html           # Storefront (halaman pembeli)
│   ├── js/storefront.js     # Logic katalog, keranjang, checkout WA
│   ├── js/cart.js           # Modul keranjang (sessionStorage)
│   ├── admin/               # Dashboard admin
│   │   ├── login.html
│   │   ├── index.html
│   │   └── js/admin.js
│   └── css/                 # style.css (storefront) + admin.css (dashboard)
├── migrations/              # Migrasi D1 bernomor (dijalankan via wrangler d1 migrations apply)
├── schema.sql               # REFERENSI saja — snapshot skema final gabungan, tidak dieksekusi langsung
├── scripts/seed-admin.mjs   # CLI buat akun admin pertama
└── wrangler.toml
```

## Catatan desain teknis
- **Frontend vanilla JS** (bukan React/Vite seperti draf awal di PRD): karena skala katalog masih 50–200 produk dan supaya bisa langsung di-serve sebagai static assets tanpa build step tambahan — konsisten dengan pola project internal lain (Kasir Cloud, Rekap Gudang WKB) yang sudah Anda pakai. Kalau memang butuh React nantinya, arsitektur API-nya sudah terpisah bersih (`/api/*`) sehingga tinggal ganti frontend saja.
- **Resize gambar otomatis**: PRD menyebut Cloudflare Images untuk resize otomatis. Cloudflare Images (produk terpisah) & Image Resizing (butuh custom domain + plan tertentu) tidak tersedia di free tier `*.workers.dev`. Untuk v1, gambar disimpan apa adanya di R2 dan disajikan lewat route `/images/:key` dengan cache 1 hari. Setelah custom domain aktif dan Anda upgrade plan, tinggal tambahkan `cf: { image: {...} }` di fetch pada route `src/routes/images.ts`.

## Setup Awal

### 1. Install dependency
```bash
npm install
```

### 2. Buat resource Cloudflare
```bash
npx wrangler d1 create toko
# copy database_id yang muncul ke wrangler.toml (ganti REPLACE_WITH_YOUR_D1_DATABASE_ID)

npx wrangler r2 bucket create toko
```

### 3. Jalankan migrasi database
```bash
# lokal (untuk dev/testing)
npm run db:migrate:local

# production (setelah database dibuat di Cloudflare)
npm run db:migrate:remote
```
Pakai `wrangler d1 migrations apply` — setiap file di `migrations/` dilacak otomatis (tabel `d1_migrations`), jadi command ini **aman dijalankan berkali-kali**: migrasi yang sudah pernah jalan tidak akan diulang. Kalau ada migrasi baru ditambahkan ke folder `migrations/`, jalankan ulang command yang sesuai — cuma file baru yang akan dieksekusi.

**Menambah kolom/tabel baru di masa depan:** jangan edit file migrasi lama. Buat file baru:
```bash
npx wrangler d1 migrations create toko nama_perubahan
```
Ini bikin file `migrations/000N_nama_perubahan.sql` — isi dengan `ALTER TABLE ...` (kolom baru di tabel lama) atau `CREATE TABLE ...` (tabel baru), lalu jalankan `npm run db:migrate:local` / `:remote` seperti biasa.

### 4. Buat akun admin pertama
```bash
npm run db:seed-admin:local     # untuk dev lokal
npm run db:seed-admin:remote    # untuk production
```
Script akan menanyakan username & password lewat terminal, lalu menyimpan hash-nya ke D1.

### 5. Jalankan lokal
```bash
npm run dev
```
- Storefront: `http://localhost:8787/`
- Admin: `http://localhost:8787/admin/login.html`

### 6. Deploy
```bash
npm run deploy
```
URL awal akan berbentuk `https://etalase-toko-wa.<subdomain>.workers.dev`. Custom domain bisa ditambahkan belakangan lewat block `routes` di `wrangler.toml` tanpa mengubah kode.

## Alur pemakaian
1. Login ke `/admin/login.html`.
2. Tambahkan kategori dulu di tab **Kategori** (opsional tapi disarankan).
3. Tambahkan produk di tab **Produk**: nama, harga, kategori, foto, status.
4. Atur nomor WA & info toko di tab **Pengaturan Toko** — termasuk format pesan checkout (placeholder `{items}`, `{total}`, `{nama}`, `{catatan}`).
5. Buka storefront di `/index.html`, produk langsung muncul begitu disimpan (tanpa perlu "publish" terpisah).

## Yang belum termasuk (sesuai scope v1 di PRD)
- Pembayaran online
- Tracking status pesanan otomatis
- Multi-toko
- Stok otomatis berkurang saat checkout
- Notifikasi email

## Keamanan
- Password admin di-hash dengan PBKDF2-SHA256 (100.000 iterasi) via Web Crypto, bukan disimpan plain text.
- Session admin disimpan sebagai token acak di tabel `admin_sessions` dengan cookie `HttpOnly` + `Secure`, kedaluwarsa 7 hari. Sesi kedaluwarsa dibersihkan otomatis setiap ada login baru.
- Rate limiting brute-force di `/api/auth/login` dan `/api/auth/change-password`: maksimal 5 percobaan gagal per 15 menit (per kombinasi username+IP), lalu terkunci 15 menit (tabel `login_attempts`).
- Upload gambar divalidasi dua lapis: MIME type dari client **dan** magic bytes isi file — file yang isinya tidak cocok dengan tipe yang diklaim akan ditolak.
- Ganti password mencabut semua sesi admin di device lain (device yang dipakai untuk ganti password tetap login).
- Semua endpoint tulis (`POST`/`PUT`/`PATCH`/`DELETE`) di `/api/products`, `/api/categories`, `/api/settings`, `/api/upload` dilindungi middleware `requireAdmin`.
