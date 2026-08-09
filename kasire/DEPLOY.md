> ⚠️ **CATATAN:** Dokumen ini ditulis untuk project lama bernama `kas` (database/bucket `kas`). Worker ini sekarang bernama **`kasire`**, dan database/bucket-nya juga baru (`kasire`) — BUKAN `kas`. Untuk langkah deploy yang benar & terbaru, pakai `DEPLOY-BARU.md` di root folder, bukan panduan di bawah ini.

# Panduan Deploy KASIR CLOUD ke Cloudflare

Panduan lengkap dari nol sampai aplikasi bisa diakses publik di `*.workers.dev`
(atau domain sendiri). Semua command dijalankan dari folder `kasir-cloud-pos/`.

---

## 0. Prasyarat

- **Node.js** versi 18 atau lebih baru (cek: `node -v`)
- **Akun Cloudflare** (paket gratis cukup) — daftar di https://dash.cloudflare.com/sign-up
- Koneksi internet untuk `wrangler login` dan proses deploy

Tidak perlu install `wrangler` secara global — sudah termasuk sebagai
`devDependency` di `package.json` dan dipanggil lewat `npx`/`npm run`.

---

## 1. Install dependency project

```bash
cd kasir-cloud-pos
npm install
```

Ini akan menginstall `hono`, `wrangler`, `typescript`, dan `@cloudflare/workers-types`.

---

## 2. Login ke akun Cloudflare

```bash
npx wrangler login
```

Browser akan terbuka, minta izin akses akun Cloudflare Anda. Klik **Allow**.

Cek sudah login dengan benar:
```bash
npx wrangler whoami
```

---

## 3. Buat database D1

```bash
npx wrangler d1 create kas
```

Output-nya akan seperti ini:
```
✅ Successfully created DB 'kas'

[[d1_databases]]
binding = "DB"
database_name = "kas"
database_id = "1a2b3c4d-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copy `database_id` tersebut**, lalu buka `wrangler.toml` dan ganti baris:
```toml
database_id = "xxxx-xxxx-xxxx-xxxx" # Ganti dengan ID dari dashboard Cloudflare
```
dengan ID asli yang baru didapat.

---

## 3b. Buat R2 Bucket (untuk foto produk yang di-upload dari panel admin)

```bash
npx wrangler r2 bucket create kas
```

Nama bucket ini sudah cocok dengan `bucket_name` di `wrangler.toml` — kalau
Anda pakai nama lain, sesuaikan juga baris `bucket_name` di `[[r2_buckets]]`.
Tidak perlu setting akses publik/custom domain apa pun untuk bucket ini —
foto disajikan lewat endpoint `GET /api/gambar/*` di Worker yang sama.

---

## 4. Set JWT_SECRET (rahasia untuk sign token login)

**JANGAN** taruh secret ini langsung di `wrangler.toml` — file itu biasanya ikut
di-commit ke git.

### Untuk production (di server Cloudflare):
```bash
npx wrangler secret put JWT_SECRET
```
Wrangler akan minta Anda mengetik nilainya di terminal (tidak akan tampil di
layar). Isi dengan string acak yang panjang, contoh cara generate cepat:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Copy hasilnya, paste saat diminta oleh `wrangler secret put`.

### Untuk development lokal (`wrangler dev`):
```bash
cp .dev.vars.example .dev.vars
```
Lalu edit `.dev.vars`, isi `JWT_SECRET` dengan string acak (boleh beda dari
production). File ini **tidak akan** ikut ke-deploy dan sudah masuk `.gitignore`.

---

## 5. Inisialisasi struktur tabel & data awal (migration)

`migrations/0001_init.sql` berisi skema lengkap **dan** seed data demo (1 toko,
2 user, 6 produk contoh) sekaligus, jadi cukup satu perintah.

### A. Lokal (untuk testing dengan `wrangler dev`)
```bash
npm run db:migrate:local
```

### B. Production (database sungguhan di Cloudflare)
```bash
npm run db:migrate:remote
```

Setelah ini, dua akun berikut sudah bisa dipakai login:

| Username | Password  | Role        |
|----------|-----------|-------------|
| admin    | admin123  | super_admin |
| kasir1   | kasir123  | kasir       |

### C. Migrasi tambahan (WAJIB dijalankan berurutan, sekali per environment)

Selain `0001_init.sql`, ada 9 migrasi susulan yang menambah fitur (split
payment, shift kasir, log aktivitas admin, pengaturan aplikasi, laporan
laba + kustomisasi struk, ikon footer struk, diskon per-item, retur
transaksi, dan metode pengembalian retur). Jalankan berurutan:

```bash
# Lokal
npm run db:migrate:local:split
npm run db:migrate:local:shift
npm run db:migrate:local:log
npm run db:migrate:local:settings
npm run db:migrate:local:laba
npm run db:migrate:local:strukikon
npm run db:migrate:local:diskonitem
npm run db:migrate:local:retur
npm run db:migrate:local:returmetode

# Production
npm run db:migrate:remote:split
npm run db:migrate:remote:shift
npm run db:migrate:remote:log
npm run db:migrate:remote:settings
npm run db:migrate:remote:laba
npm run db:migrate:remote:strukikon
npm run db:migrate:remote:diskonitem
npm run db:migrate:remote:retur
npm run db:migrate:remote:returmetode
```

`0004_log_aktivitas.sql` menambah tabel `log_aktivitas` yang dipakai tab
**Log Aktivitas** di panel admin (mencatat siapa mengubah harga produk,
menonaktifkan user, membatalkan transaksi, dll). Kalau tab ini menampilkan
error setelah update, kemungkinan besar migrasi ini belum dijalankan.

`0005_pengaturan.sql` menambah tabel `pengaturan` (key/value) yang dipakai
untuk judul aplikasi yang bisa diubah lewat panel admin (tab **Kelola
Toko** → Pengaturan Aplikasi). Kalau judul aplikasi gagal disimpan atau
`GET /api/settings` error, kemungkinan besar migrasi ini belum dijalankan.

`0006_laba_dan_struk.sql` menambah kolom `hpp_satuan` di `detail_transaksi`
(dipakai **Laporan Laba** di dashboard admin — laba kotor = omzet - HPP,
snapshot per transaksi) dan 4 baris pengaturan baru di tabel `pengaturan`
untuk **Kustomisasi Struk** (footer, catatan, lebar kertas, tampilkan
alamat). Kalau laporan laba menampilkan 0 terus atau kustomisasi struk
gagal disimpan, kemungkinan besar migrasi ini belum dijalankan.

`0007_struk_ikon.sql` menambah 2 baris pengaturan (`struk_footer_ikon`,
`struk_qr_data`) untuk pilihan ikon di bagian bawah struk: kosong, QR
code asli (bisa di-scan, digenerate di browser kasir — cocok untuk link
WhatsApp/Instagram/website toko), atau nama toko sebagai teks besar. Kalau
pilihan ikon footer di panel admin gagal disimpan, kemungkinan besar
migrasi ini belum dijalankan.

`0008_diskon_item.sql` menambah kolom `diskon_item` di `detail_transaksi`,
dipakai fitur diskon per-item di keranjang kasir (beda dari diskon total
transaksi yang sudah ada sejak awal). Kalau tombol "Diskon item" di kasir
gagal disimpan, kemungkinan besar migrasi ini belum dijalankan.

`0009_retur.sql` menambah kolom `qty_retur`/`subtotal_retur` di
`detail_transaksi` plus tabel `retur` & `retur_item` baru, dipakai fitur
Retur Transaksi (tab Riwayat Transaksi di admin panel, dan menu akun di
layar kasir). Kalau proses retur gagal atau tab Riwayat Transaksi error,
kemungkinan besar migrasi ini belum dijalankan.

`0010_retur_metode_pengembalian.sql` menambah kolom
`retur.metode_pengembalian` (wajib diisi 'cash' atau 'non_cash' tiap kali
retur diproses) supaya kalkulasi kas sistem shift ikut mengurangi retur
yang uangnya dikembalikan tunai dari laci. **Kalau migrasi ini belum
dijalankan tapi kode terbaru sudah di-deploy, SEMUA proses retur akan
gagal** (backend mewajibkan kolom ini, request tanpa itu ditolak) — jangan
sampai deploy kode duluan tanpa migrasi ini menyusul.


⚠️ **Wajib ganti password ini sebelum benar-benar dipakai di lapangan** — lihat
bagian [8. Mengganti password default](#8-mengganti-password-default).

---

## 6. Testing lokal dulu sebelum deploy

```bash
npm run dev
```

Wrangler akan menjalankan Worker + static assets di `http://localhost:8787`.
Buka:
```
http://localhost:8787/login.html
```
Login dengan salah satu akun di atas. Kalau berhasil masuk ke halaman kasir
(atau dashboard admin, tergantung role) dan produk dari seed data muncul,
berarti backend, database, dan frontend sudah terhubung dengan benar.

Kalau ada error, cek terminal tempat `npm run dev` berjalan — semua error
backend (termasuk `console.error` dari `onError`) muncul di sana.

> Catatan: request ke `/login.html` akan mendapat redirect 307 otomatis ke
> `/login` (perilaku default static assets Cloudflare yang menyederhanakan
> URL). Ini normal dan tidak memengaruhi fungsi — browser mengikuti redirect
> secara transparan.

---

## 7. Deploy ke Cloudflare

```bash
npm run deploy
```

Karena `[assets]` sudah dikonfigurasi di `wrangler.toml`, perintah ini
men-deploy **backend dan frontend sekaligus** dalam satu Worker — tidak perlu
langkah terpisah untuk Cloudflare Pages.

Output akan menampilkan URL publik, contoh:
```
https://kas.<subdomain-anda>.workers.dev
```

Buka `https://kas.<subdomain-anda>.workers.dev/login.html` dari browser
manapun — aplikasi sudah live dan bisa langsung di-"Add to Home Screen" (PWA).

### Update `ALLOWED_ORIGIN` setelah tahu domain final
Karena frontend & backend disajikan dari **domain yang sama**, `ALLOWED_ORIGIN`
tidak kritikal untuk mode ini, tapi tetap disarankan diselaraskan agar CORS
tidak bermasalah kalau suatu saat frontend dipindah ke domain lain:
```toml
[vars]
ALLOWED_ORIGIN = "https://kas.<subdomain-anda>.workers.dev"
```
Lalu deploy ulang: `npm run deploy`.

---

## 8. Mengganti password default

Cara paling gampang: generate hash baru dengan script yang sudah disediakan,
lalu update lewat SQL.

```bash
node scripts/gen-password-hash.mjs "PASSWORD_BARU_ANDA"
```

Ini akan mencetak `password_hash` dan `password_salt`. Copy keduanya, lalu
jalankan (ganti `USERNAME`, `HASH_HASIL`, `SALT_HASIL`):

```bash
npx wrangler d1 execute kas --remote --command "UPDATE users SET password_hash='HASH_HASIL', password_salt='SALT_HASIL' WHERE username='USERNAME';"
```

---

## 9. Perintah operasional yang sering dipakai

| Kebutuhan | Command |
|---|---|
| Lihat log real-time dari Worker production | `npx wrangler tail` |
| Query database production langsung | `npx wrangler d1 execute kas --remote --command "SELECT * FROM produk;"` |
| Tambah produk baru manual | `npx wrangler d1 execute kas --remote --command "INSERT INTO produk (toko_id, kode_produk, nama, harga_jual, stok) VALUES (1, '899999999', 'Produk Baru', 5000, 100);"` |
| Redeploy setelah ubah kode | `npm run deploy` |
| Cek daftar secret yang sudah diset | `npx wrangler secret list` |
| Hapus/ganti secret | `npx wrangler secret put JWT_SECRET` (menimpa yang lama) |
| Tambah toko/cabang baru | `npx wrangler d1 execute kas --remote --command "INSERT INTO toko (nama, alamat) VALUES ('Toko Cabang 2', 'Alamat...');"` |
| Lihat daftar foto produk tersimpan di R2 | `npx wrangler r2 object list kas` |
| Hapus 1 foto produk manual dari R2 | `npx wrangler r2 object delete kas/produk/<nama-file>.jpg` |

---

## 10. Pakai domain sendiri (opsional)

Kalau punya domain yang sudah terdaftar di Cloudflare (DNS-nya dikelola
Cloudflare):

1. Buka **Cloudflare Dashboard → Workers & Pages → kas → Settings → Domains & Routes**
2. Klik **Add Custom Domain**, masukkan domain/subdomain Anda (misal `kasir.tokoanda.com`)
3. Cloudflare otomatis membuat DNS record & sertifikat SSL
4. Update `ALLOWED_ORIGIN` di `wrangler.toml` jadi domain baru itu, lalu `npm run deploy` ulang

---

## 11. Mengaktifkan geo-restriction (Indonesia-only, opsional)

Secara default `ENFORCE_GEO = "false"` di `wrangler.toml` (supaya mudah
ditest dari mana saja). Untuk mengaktifkan pembatasan hanya dari Indonesia
saat production:

```toml
[vars]
ENFORCE_GEO = "true"
```
lalu `npm run deploy` ulang.

---

## 12. Troubleshooting

**Login selalu gagal walau password benar**
→ Pastikan `npm run db:migrate:remote` sudah pernah dijalankan, dan pastikan
`JWT_SECRET` sudah diset (`wrangler secret put JWT_SECRET` untuk production,
`.dev.vars` untuk lokal). Tanpa `JWT_SECRET`, signing token akan gagal dan
login akan selalu error 500.

**Muncul "Kesalahan server internal" terus**
→ Jalankan `npx wrangler tail` (production) atau lihat terminal `npm run dev`
(lokal) untuk lihat error aslinya — biasanya karena `database_id` di
`wrangler.toml` belum diganti dari placeholder, atau migration belum dijalankan.

**Login berhasil tapi langsung ke-redirect balik ke login.html**
→ Cek apakah domain sudah HTTPS. Cookie session diset `secure: true`, artinya
browser hanya mau kirim cookie ini lewat HTTPS. `*.workers.dev` sudah otomatis
HTTPS, jadi ini biasanya hanya masalah saat testing di `http://` non-`localhost`.

**Produk tidak muncul / kosong**
→ Cek `npm run db:migrate:remote` sudah dijalankan. Cek juga lewat:
```bash
npx wrangler d1 execute kas --remote --command "SELECT * FROM produk;"
```

**Request dari luar Indonesia ditolak (403)**
→ Itu `ENFORCE_GEO`. Set `ENFORCE_GEO = "false"` di `wrangler.toml` saat masih
testing dari luar, aktifkan lagi (`"true"`) saat sudah siap production.

**CORS error di console browser**
→ Cek `ALLOWED_ORIGIN` di `wrangler.toml` sudah mencantumkan origin frontend
yang benar. Kalau frontend & backend satu domain (default setup di panduan
ini lewat `[assets]`), ini seharusnya tidak pernah terjadi.

**Service worker menampilkan versi lama setelah update kode**
→ `sw.js` memakai nama cache versi tertentu. Naikkan versinya setiap kali
mengubah isi `public/` secara signifikan, supaya browser pengguna lama tahu
harus mengambil ulang app-shell dan membuang cache lama (`activate` event di
`sw.js` sudah otomatis menghapus cache dengan nama berbeda).

**Upload foto produk gagal ("Gagal upload gambar" / error 500)**
→ Bucket R2 belum dibuat, atau nama `bucket_name` di `wrangler.toml` tidak
cocok dengan bucket yang sungguhan ada. Jalankan `npx wrangler r2 bucket create kas`
(lihat langkah 3b), lalu `npm run deploy` ulang supaya binding `IMAGES` ter-attach.

**Foto produk yang sudah diupload tidak muncul (404) di `GET /api/gambar/...`**
→ Kemungkinan foto itu diupload saat testing di `wrangler dev --local` (R2
lokal, terpisah dari R2 production) lalu dibuka lewat URL production, atau
sebaliknya. R2 lokal dan production adalah penyimpanan yang berbeda — foto
yang diupload lewat `npm run dev` tidak akan ada di production, dan sebaliknya.

**Tambah produk atau upload foto gagal dengan pesan "upgrade langganan"**
→ Ini bukan bug — aplikasi punya batas langganan bawaan: maksimal 200 produk
aktif dan 500MB total foto di R2 (gabungan SEMUA toko, bukan per-toko). Kalau
memang perlu dinaikkan, ubah konstanta `PRODUK_MAX_TOTAL` dan
`R2_MAX_BYTES_TOTAL` di `src/index.ts`, lalu `npm run deploy` ulang.



