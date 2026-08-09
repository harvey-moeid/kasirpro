# Deploy Baru: 1 Domain — Etalase (root) + Kasire (/kasir)

Status: **DRAFT di sandbox**, belum di-deploy. Project Kasir Cloud lama
Anda (kalau ada) tidak disentuh sama sekali — semua resource di sini baru.

Arsitektur: **1 domain**, 2 Worker terpisah (`kasire`, `etalase`), 1
database D1 bersama + 1 R2 bucket bersama (keduanya bernama `kasire`).
Etalase pegang root domain (publik saja, tidak ada admin/login di situ
lagi), kasire hidup di `domainanda.com/kasir` (1 panel admin untuk
semuanya — kasir DAN etalase). Detail teknis lengkap: `ARSITEKTUR.md`.

---

## Prasyarat: Domain Harus Zone Aktif di Cloudflare

Path-based routing (1 domain untuk 2 Worker) **hanya bisa lewat
Cloudflare Routes**, yang mensyaratkan domain Anda terdaftar sebagai
*zone* di akun Cloudflare (DNS dikelola Cloudflare) — beda dengan fitur
"Custom Domain" biasa untuk Workers yang cuma butuh 1 klik tanpa perlu
DNS penuh. Kalau domain Anda belum ditambahkan sebagai site/zone di
Cloudflare, lakukan itu dulu (Cloudflare Dashboard → Add a Site) sebelum
lanjut ke langkah di bawah.

---

## Langkah 1 — Login & buat resource baru (sekali saja)

```bash
npx wrangler login

cd kasire
npx wrangler d1 create kasire
```

Salin `database_id` dari output ke **dua tempat** (harus identik):
- `kasire/wrangler.toml` → ganti `GANTI_DENGAN_DATABASE_ID_HASIL_D1_CREATE`
- `etalase/wrangler.toml` → ganti `GANTI_DENGAN_DATABASE_ID_HASIL_D1_CREATE`

```bash
npx wrangler r2 bucket create kasire
```
R2 SATU bucket saja (dulu 2, sekarang digabung) — dipakai bersama oleh
kasire (foto utama produk) & etalase (galeri/logo/banner), semua diupload
lewat panel admin kasire.

## Langkah 2 — Ganti "domainanda.com" dengan domain asli Anda

Di **kedua** file, cari-ganti `domainanda.com` → domain Anda yang
sebenarnya (harus SAMA PERSIS di kedua file, ini domain tunggal yang
dipakai bersama):
- `kasire/wrangler.toml` (blok `routes` di bagian paling bawah)
- `etalase/wrangler.toml` (blok `routes`)

## Langkah 3 — Migrasi database (sekali saja, dari folder kasire)

```bash
cd kasire
npm install
npx wrangler d1 migrations apply kasire --remote
```

Bikin semua tabel (kasir + etalase) + seed data contoh: 1 toko "Toko
Pusat" (id=1), akun `admin`/`admin123`, `kasir1`/`kasir123` (akun ini JUGA
dipakai untuk kelola etalase — 1 login untuk semuanya, tidak ada akun
admin terpisah lagi), 6 produk contoh (5 tampil online, 1 disembunyikan).

## Langkah 4 — Set JWT_SECRET

```bash
npx wrangler secret put JWT_SECRET
# isi string acak panjang, mis. hasil: openssl rand -base64 48
```

## Langkah 5 — Deploy kasire

```bash
npm run deploy
```

Wrangler akan otomatis mendaftarkan Route `domainanda.com/kasir` dan
`domainanda.com/kasir/*` ke Worker ini (sesuai isi `wrangler.toml`).

## Langkah 6 — Cek & sesuaikan toko_id

```bash
npx wrangler d1 execute kasire --remote --command="SELECT id, nama FROM toko"
```

Seed data pakai `id=1`. Kalau cabang production Anda beda:

```bash
npx wrangler d1 execute kasire --remote --command="UPDATE store_settings SET toko_id = <ID_YANG_BENAR> WHERE id = 1"
```

Lalu update `etalase/wrangler.toml` → `STORE_TOKO_ID = "<ID_YANG_BENAR>"`
(harus sama persis dengan `store_settings.toko_id`).

## Langkah 7 — Deploy etalase

```bash
cd ../etalase
npm install
npm run deploy
```

Ini otomatis mendaftarkan Route `domainanda.com/*` ke Worker ini.
Tidak ada langkah "buat akun admin etalase" lagi — kelola etalase (produk,
kategori, pengaturan toko, riwayat pesanan) sekarang lewat tab "Etalase
Online" di panel admin kasire, pakai akun kasir yang sama (Langkah 3).

---

## Langkah 9 — Verifikasi

1. Buka `https://domainanda.com/` → harus muncul etalase (bukan kasir).
2. Buka `https://domainanda.com/kasir` → harus **redirect otomatis**
   ke `https://domainanda.com/kasir/login.html` (bukan 404, bukan
   nyasar ke halaman etalase).
3. Login kasir (`admin`/`admin123`) → cek semua fitur jalan normal
   (dashboard, produk, transaksi) — kalau ada tombol yang gagal
   fetch/loading terus, cek Console browser: kemungkinan besar ada
   pemanggilan API yang lupa lewat `API_BASE` (lihat `ARSITEKTUR.md` §2).
4. Cek 5 produk contoh muncul di etalase publik (`/`).
5. Koreksi stok salah satu produk di kasire sampai 0 → refresh etalase
   → produk itu harus otomatis hilang dari daftar publik.
6. Di panel admin kasire, buka tab "Etalase Online" → cek pengaturan
   toko bisa disimpan, kategori bisa ditambah, riwayat pesanan (kalau
   ada) muncul. Coba tambah produk baru & centang "Tampilkan di Etalase
   Online" → cek muncul di etalase publik.
7. (Opsional, kalau pakai PWA) Install kasir sebagai app dari
   `/kasir/login.html` → cek ikon & nama app benar, coba buka offline.

Kalau Langkah 2 gagal (redirect salah / 404) → kemungkinan besar Route
di `kasire/wrangler.toml` belum ke-deploy dengan benar, atau domain
belum jadi zone Cloudflare aktif (lihat bagian Prasyarat).

## Langkah 10 — Sebelum go-live sungguhan

- Ganti password default `admin`/`kasir1` (akun ini JUGA dipakai untuk
  kelola etalase — 1 login untuk semuanya).
- Hapus/ganti 6 produk contoh dari seed data.
- Cek `ENFORCE_GEO` di `kasire/wrangler.toml` — set `"true"` kalau
  sudah siap production.
- Di tab "Etalase Online" panel admin, cek produk mana yang mau
  ditampilkan & lengkapi pengaturan toko (nama, WA, logo, banner).

Detail arsitektur & daftar perbaikan bug dari sesi review sebelumnya:
lihat **`ARSITEKTUR.md`**.
