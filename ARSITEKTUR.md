# Arsitektur: 1 Domain — Etalase (root) + Kasire (/kasir)

Status: **DRAFT di sandbox**, belum di-deploy.

## 1. Perubahan dari Versi Sebelumnya

Sebelumnya: 2 domain terpisah (`kasir.domainanda.com` & `toko.domainanda.com`).

Sekarang: **1 domain**, 2 Worker tetap terpisah, dibedakan lewat **path**:

| Path | Worker | Peran |
|---|---|---|
| `domainanda.com/` (root, semua path lain) | **etalase** | Etalase publik — route utama |
| `domainanda.com/kasir` dan `domainanda.com/kasir/*` | **kasire** | Kasir + admin produk |

Database tetap 1 (D1 `kasire`), tetap dibaca-tulis dengan aturan yang sama
seperti sebelumnya (lihat bagian 3). **Yang berubah cuma cara Cloudflare
merutekan HTTP request ke masing-masing Worker** — bukan skema database.

## 2. Cara Kerja Teknis (penting kalau mau ubah kode nanti)

Cloudflare **Routes** (bukan Custom Domain — Custom Domain cuma bisa 1
domain = 1 worker, tidak bisa split per-path) dipakai untuk memecah 1
domain ke 2 Worker:

```
kasire/wrangler.toml:
  routes = [
    { pattern = "domainanda.com/kasir", zone_name = "domainanda.com" },
    { pattern = "domainanda.com/kasir/*", zone_name = "domainanda.com" }
  ]

etalase/wrangler.toml:
  routes = [
    { pattern = "domainanda.com/*", zone_name = "domainanda.com" }
  ]
```

Cloudflare selalu memilih pattern **paling spesifik** kalau ada beberapa
yang cocok, jadi `/kasir/*` tetap menang lawan `/*` milik etalase —
tidak saling rebutan. (2 pattern dipakai untuk kasire — bukan cuma
`/kasir/*` — karena `/kasir/*` TIDAK cocok dengan `/kasir` persis tanpa
trailing slash; ini gotcha yang didokumentasikan resmi oleh Cloudflare.)

**Prasyarat penting**: domain harus jadi *zone* aktif di akun Cloudflare
Anda (dikelola lewat Cloudflare DNS), bukan sekadar "custom domain"
ala Workers biasa — path-based routing cuma bisa lewat Routes, yang
butuh zone.

Karena kasire sekarang hidup di `/kasir`, bukan di root Worker-nya
sendiri, ada 2 masalah teknis yang harus ditangani (sudah diimplementasi):

1. **File statis** (`admin.html`, `index.html`, dst.) disimpan di
   `kasire/public/` TANPA folder `kasir/` tambahan (strukturnya tidak
   diubah). Supaya Cloudflare tetap menemukan file yang benar saat
   diakses lewat `/kasir/admin.html`, `kasire/wrangler.toml` diset
   `run_worker_first = ["/kasir", "/kasir/*"]` — artinya SETIAP request
   ke `/kasir/*` SELALU lewat kode Worker (`src/index.ts`) dulu, baru
   dari situ Worker membuang prefix `/kasir` dan memanggil
   `env.ASSETS.fetch()` secara manual. Lihat fungsi `fetch()` paling
   bawah di `kasire/src/index.ts`.
2. **Semua path absolut di frontend** (`fetch('/api/...')`,
   `href="/manifest.json"`, dll.) diubah supaya benar di bawah `/kasir/`:
   - Referensi file statis (`icons/`, `manifest.json`, `styles.css`,
     `sw.js`, `*.html` antar-halaman) diubah jadi **relatif** (tanpa `/`
     di depan) — otomatis benar karena browser resolve relatif terhadap
     folder halaman saat ini (`/kasir/`).
   - Semua panggilan API (`fetch`) memakai variabel `API_BASE` yang
     SEKARANG diisi `'/kasir'` (sebelumnya string kosong `''`) — jadi
     `${API_BASE}/api/produk` otomatis jadi `/kasir/api/produk`.
   - `manifest.json`: `start_url` & `scope` disesuaikan (`scope` WAJIB
     `/kasir/`, bukan `/`, supaya tidak klaim seluruh domain sebagai
     cakupan PWA kasir).
   - `sw.js`: `APP_SHELL` jadi path relatif, pengecualian `/api/` di
     fetch handler diubah jadi `/kasir/api/`. Versi cache dinaikkan
     (`v21` → `v22`) supaya cache lama (berisi path absolut lama) tidak
     kepakai lagi setelah update.
   - Endpoint upload foto kasire (`POST /api/upload/produk`) sekarang
     mengembalikan URL dengan prefix `/kasir` (`.../kasir/api/gambar/xxx`).

**Kalau nanti nambah fetch() atau href baru di kasire**, WAJIB pakai
salah satu dari 2 pola di atas (relatif tanpa `/` di depan, ATAU lewat
`API_BASE`) — jangan hardcode `/api/...` langsung, nanti nyasar ke
etalase karena `/api/...` (tanpa `/kasir`) akan di-route ke etalase,
bukan kasire.

## 3. Admin Digabung Jadi 1 (perubahan besar dari versi sebelumnya)

Sebelumnya: etalase punya panel admin & login sendiri (`admin_users`,
terpisah dari kasir). Sekarang: **1 panel admin, 1 login** — semuanya
lewat kasire (`/kasir/admin.html`), pakai akun `users` kasir yang sama
(role `super_admin`/`admin_toko`). Tabel `admin_users`/`admin_sessions`/
`login_attempts` sudah DIHAPUS dari skema.

Yang dulu ada di panel admin etalase, sekarang di tab **"Etalase Online"**
panel admin kasire:
- Pengaturan toko (nama, WA, alamat, jam buka, banner, tema, logo)
- Kelola kategori (nama/slug — dipakai bersama kasir & etalase)
- Riwayat pesanan checkout WhatsApp (read-only)

Kelola visibilitas produk di etalase (tampil/sembunyi, slug, deskripsi
khusus etalase, harga coret, galeri foto tambahan) sekarang jadi bagian
dari form **"Kelola Produk"** yang sudah ada di kasire — cukup centang
"Tampilkan di Etalase Online" saat tambah/edit produk, field lain
otomatis muncul.

Worker `etalase` sekarang BENAR-BENAR cuma berisi route publik (baca
produk/kategori/settings, terima checkout WA, serve gambar) — tidak ada
`auth.ts`, tidak ada halaman admin/login sama sekali di foldernya.
Semua endpoint admin (termasuk yang dulu ada di etalase: kelola produk,
kategori, pengaturan, pesanan) sekarang didefinisikan di
`kasire/src/index.ts`, dilindungi middleware auth kasir yang sudah ada
(`requireAuth`, `requireRole`).

**R2 juga digabung jadi 1 bucket** (dulu 2 bucket terpisah, `kasire` &
`etalase`). Semua upload (foto produk, galeri, logo, banner) sekarang
lewat panel admin kasire, ditulis ke bucket yang sama. Tidak ada
tabrakan key: foto produk pakai prefix `produk/`, aset etalase pakai
prefix `etalase/`.

## 4. Aturan Kepemilikan Data

- **Stok**: hanya kasire yang menulis (transaksi jual, koreksi stok).
  Etalase cuma baca — status tersedia/habis di etalase diturunkan
  otomatis dari `stok > 0`.
- **Tampil/sembunyi di etalase** (`tampil_online`), slug, deskripsi
  khusus etalase, harga coret: diedit dari kasire (form produk), tersimpan
  di kolom yang sama yang dibaca etalase — tidak ada proses sync terpisah.
- **Foto utama produk & galeri tambahan**: upload dari kasire saja
  (tidak ada lagi endpoint upload di etalase). URL foto utama sudah
  termasuk prefix `/kasir/api/gambar/...`, otomatis benar walau
  ditampilkan dari halaman etalase di path lain.
- **Cap 200 produk aktif**: global gabungan semua cabang
  (`PRODUK_MAX_TOTAL` di `kasire/src/index.ts`) — sekarang cuma ada 1
  definisi (dulu ada 2, harus disinkron manual; sekarang otomatis
  konsisten karena cuma 1 tempat).
- Nonaktifkan produk di kasir (`is_active=0`) → otomatis hilang dari
  etalase juga (query etalase selalu filter `is_active=1`).

## 5. Daftar Perbaikan dari Sesi-Sesi Review Sebelumnya

(Ringkas — detail lengkap ada di riwayat chat, ini cuma daftar biar
tidak lupa kalau baca ulang kode nanti)

1. Cap 200 produk sempat salah scope (per-cabang, seharusnya global) — diperbaiki.
2. API publik etalase sempat membocorkan angka stok asli — dipisah jadi mapping publik vs admin.
3. Tombol toggle status di admin etalase sempat nyasar (baca dari stok, nulis ke tampil_online) — dipisah jadi 2 kolom terpisah di tabel admin.
4. Form produk sempat punya dropdown "Status" yang diam-diam diabaikan backend, dan tidak ada field stok awal — diganti checkbox "Tampilkan di Etalase" + field "Stok Awal" yang benar-benar fungsional.
5. `kode_produk` auto-generate sempat tanpa cek keunikan — ditambah retry.
6. Etalase sempat tidak punya global error handler sama sekali — ditambahkan.
7. Admin digabung jadi 1 (lihat bagian 3): tabel auth terpisah etalase dihapus, R2 digabung jadi 1 bucket, endpoint & UI etalase (produk, kategori, pengaturan toko, riwayat pesanan) dipindah ke panel admin kasire.

## 6. Deploy Multi-Cabang (banyak domain, 1 database)

Skema & backend sudah disiapkan untuk ini (`toko_id` scoping menyeluruh —
lihat hasil audit di bawah). Pola yang dipakai: **1 database D1 + 1 R2
bersama, kasire di-deploy SEKALI (1 domain pusat), etalase di-deploy
BERKALI-KALI (1x per cabang/domain)**.

### Kenapa bukan 1 Worker etalase untuk semua domain?

`STORE_TOKO_ID` di etalase itu 1 env var TETAP per-deployment. Kalau 5
domain diarahkan ke Worker etalase yang SAMA, kelimanya akan menampilkan
cabang yang SAMA (bukan 5 toko berbeda) — bukan cuma salah tampil, tapi
juga berarti pesanan WA dari 5 domain akan tercatat ke `toko_id` yang
sama. Solusinya: deploy Worker etalase terpisah per cabang, kodenya
identik, cuma beda `STORE_TOKO_ID` & nama Worker.

### Langkah tambah cabang baru (mis. cabang ke-2)

```bash
# 1. Tambah baris toko baru (kalau belum ada)
npx wrangler d1 execute kasire --remote --command="INSERT INTO toko (nama, alamat) VALUES ('Cabang Bandung', 'Jl. Contoh No. 2')"

# 2. Cek id toko yang baru dibuat
npx wrangler d1 execute kasire --remote --command="SELECT id, nama FROM toko"

# 3. Copy folder etalase jadi deployment baru (atau pakai folder yang sama,
#    ganti isi wrangler.toml tiap kali mau deploy cabang berbeda -- lebih
#    rapi kalau dicopy supaya wrangler.toml masing-masing permanen)
cp -r etalase etalase-cabang2
cd etalase-cabang2
```

Edit `wrangler.toml` di folder baru itu:
```toml
name = "etalase-cabang2"          # HARUS unik per cabang
STORE_TOKO_ID = "2"                # id toko dari langkah 2 di atas
routes = [
  { pattern = "cabang2.domainanda.com/*", zone_name = "domainanda.com" }
  # atau domain custom sendiri kalau tiap cabang punya domain berbeda
]
```

`database_id` & `bucket_name` (R2) **JANGAN diubah** — tetap sama persis
dengan `kasire/wrangler.toml` (itu intinya, 1 database + 1 R2 dipakai
bersama semua cabang).

```bash
npm install
npm run deploy
```

Ulangi untuk cabang ke-3, 4, 5 (tiap kali `toko_id` & `name` & `routes`
beda, sisanya sama).

### Kasir/admin per cabang

Kasire **tetap 1 deployment** (tidak perlu dicopy 5x) — cukup buat akun
`admin_toko` baru per cabang lewat panel admin (tab Kasir/User → Tambah
User, sebagai super_admin), isi `toko_id` sesuai cabangnya. Akun
`admin_toko` otomatis:
- Cuma lihat/kelola produk, transaksi, user (kasir), & pengaturan etalase
  **cabangnya sendiri** — dicek di server (bukan cuma disembunyikan di
  UI), lihat hasil audit di bawah.
- Tab "Etalase Online" otomatis terkunci ke cabangnya (tidak ada
  pemilih cabang, beda dari super_admin yang punya dropdown pilih cabang).

`super_admin` bisa kelola SEMUA cabang **DALAM tenant/toko_pusat-nya
sendiri** dari 1 login yang sama (lihat §8 — sejak fitur multi-tenant,
super_admin TIDAK LAGI global lintas seluruh database), termasuk
pilih cabang mana yang mau dikelola di tab "Etalase Online".

### Audit "data tidak bocor" — hasil pengecekan menyeluruh

Ditelusuri semua 46 endpoint di `kasire/src/index.ts` satu-satu untuk
memastikan `admin_toko`/`kasir` tidak bisa akses data cabang lain lewat
manipulasi ID di request (IDOR). Hasilnya:

- **Sudah aman dari sesi-sesi sebelumnya** (ada komentar `FIX (security)`
  di kode): transaksi (lihat/batalkan/retur), user (lihat/ubah), produk
  (tambah/ubah/hapus/koreksi stok) — semua sudah dicek kepemilikan
  `toko_id` sebelum boleh diakses.
- **Ditemukan & diperbaiki sesi ini**: endpoint galeri foto produk
  (`POST`/`DELETE /api/produk/:id/galeri`) yang baru ditambahkan untuk
  fitur Etalase Online TERNYATA tidak mengecek kepemilikan toko sama
  sekali — `admin_toko` cabang mana pun bisa upload/hapus foto galeri
  produk cabang LAIN cuma dengan menebak ID produk. Sudah diperbaiki
  (pakai helper `getProdukAtauTolak` yang sama dengan endpoint produk
  lain).
- **Diperbaiki juga**: `store_settings` & `orders` yang sebelumnya cuma
  1 baris/tabel tanpa `toko_id` (didesain untuk 1 toko saja) — sekarang
  `store_settings` 1 baris per cabang, `orders` punya kolom `toko_id`,
  dan endpoint `/api/etalase/settings` & `/api/etalase/orders` di-scope
  konsisten dengan pola endpoint lain.
- **Kategori** (`kategori`) SENGAJA tidak di-scope per toko — memang
  dipakai bersama lintas cabang by design (1 daftar kategori untuk
  semua). `admin_toko` bisa ubah/hapus kategori yang juga dipakai
  cabang lain — ini BUKAN celah keamanan/data-leak, tapi pertimbangkan
  dampak operasionalnya (mengubah nama kategori dari 1 cabang
  memengaruhi tampilan produk di etalase cabang lain juga).

**Belum diaudit menyeluruh**: endpoint shift kasir & log aktivitas (dicek
sekilas, terlihat aman, tapi tidak ditelusuri baris-per-baris sedetail
transaksi/produk/user di atas). Kalau mau 100% yakin sebelum go-live
dengan data sungguhan, minta saya audit 2 bagian itu juga.

## 8. Multi-Tenant (toko_pusat)

Level baru DI ATAS `toko` (cabang): **`toko_pusat`** — 1 baris = 1
pelanggan/bisnis berbeda, isolasi TOTAL, tidak boleh saling lihat data
sama sekali. Struktur: `toko_pusat` (1) → `toko`/cabang (banyak) →
`users` (kasir/admin_toko per cabang, super_admin per toko_pusat).

```
toko_pusat (tenant, mis. "Bisnis A")
  └─ toko (cabang, mis. "Cabang Bandung", "Cabang Jakarta")
       └─ users (kasir, dikunci ke 1 toko)
  └─ users (super_admin, dikunci ke toko_pusat — lihat SEMUA cabang di bawahnya)
```

`super_admin` **BUKAN LAGI global** — sebelum fitur ini, 1 baris
`super_admin` bisa lihat/ubah SEMUA data di seluruh database (semua
tenant tercampur). Sekarang dikunci ke `toko_pusat_id` miliknya sendiri,
sama persis prinsipnya dengan `admin_toko` dikunci ke `toko_id`.

**Cara kerja teknis**: `toko_pusat_id` ada di JWT session (di-set saat
login), dan 2 helper di `kasire/src/index.ts` dipakai konsisten di
seluruh endpoint:
- `getTokoIdsUntukTenant(db, toko_pusat_id)` — semua cabang dalam 1 tenant.
- `validasiTokoIdMilikTenant(db, session, tokoId)` — cek toko_id yang
  diminta lewat query/body BENERAN milik tenant sesi ini, bukan asal
  percaya angka dari client. WAJIB dipanggil di setiap endpoint yang
  menerima `toko_id` dari luar.

**Audit keamanan (sesi ini)**: ~20 endpoint ditelusuri satu-satu untuk
titik "super_admin bebas akses" — hampir semua ternyata bocor lintas
tenant sebelum diperbaiki (termasuk 5 endpoint laporan keuangan, GET
`/api/toko`, GET/POST `/api/users`, dan yang paling parah: helper
`getProdukAtauTolak` yang dipakai 6+ endpoint sekaligus, serta endpoint
reset-data yang tadinya bisa menghapus TOTAL data tenant lain tanpa
validasi). Detail lengkap: `PROSES.md` poin 18.

**Sudah diperbaiki (sesi berikutnya)**: kuota R2 500MB sekarang dihitung
PER TENANT, bukan global lintas semua tenant. Key R2 direstruktur pakai
prefix `produk/{toko_pusat_id}/...` (foto utama produk) dan
`etalase/{toko_pusat_id}/...` (galeri/logo/banner) — kuota dihitung
lewat R2 list-by-prefix (`hitungTotalUkuranR2UntukTenant`), tidak perlu
scan seluruh bucket lintas tenant lagi.

**Masih belum dikerjakan**: belum ada alur bikin `toko_pusat` baru +
super_admin pertamanya lewat aplikasi — asumsi sementara: operasi
manual lewat SQL oleh pemilik platform, bukan self-service signup.

## 9. Yang Sudah Dites di Sandbox

- Migrasi SQL jalan bersih (18 tabel + seed data — turun dari 21 setelah
  `admin_users`/`admin_sessions`/`login_attempts` dihapus), berkali-kali
  diulang setelah setiap perubahan.
- `tsc --noEmit` — 0 error di kasire & etalase, termasuk setelah
  restrukturisasi 1-domain & penggabungan admin.
- Ditelusuri manual seluruh referensi path absolut di `kasire/public/`
  (HTML, sw.js, manifest.json) — tidak ada sisa yang masih hardcode
  `/api/`, `/icons/`, dll. tanpa prefix `/kasir` atau tanpa jadi relatif.
- Dicek referensi `API_BASE` konsisten dipakai di ketiga halaman
  (`index.html`, `admin.html`, `login.html`).
- Sintaks JS di ketiga halaman kasire divalidasi (`node --check`) —
  tidak ada error sintaks di kode tab "Etalase Online" yang baru
  ditambahkan ke `admin.html`.

**Belum bisa dites dari sandbox** (butuh domain & akun Cloudflare
sungguhan, atau minimal `wrangler dev` + browser):
- Apakah Route pattern benar-benar merutekan seperti yang
  didokumentasikan, apakah `run_worker_first` + `env.ASSETS.fetch()`
  manual benar-benar menyajikan file statis dengan header/cache yang
  tepat, dan uji end-to-end PWA (install, offline mode) di bawah path
  `/kasir/`.
- **Tab "Etalase Online" yang baru** (pengaturan toko, upload logo/
  banner, galeri foto per produk, kategori, riwayat pesanan) — sudah
  ditelusuri logika kodenya (payload, nama field, alur upload) tapi
  BELUM pernah dicoba klik sungguhan di browser. Kemungkinan area
  paling rawan ada bug kecil (mis. selector elemen yang salah ketik,
  urutan async yang meleset) karena ini bagian terbaru & belum ada
  "putaran kedua" review seperti bagian lain.

**Sangat disarankan uji manual menyeluruh setelah deploy** mengikuti
checklist di `DEPLOY-BARU.md` bagian "Verifikasi", DAN coba semua
tombol di tab "Etalase Online" satu-satu (simpan pengaturan, upload
logo/banner, tambah/hapus kategori, centang "Tampilkan di Etalase" di
form produk lalu cek field tambahan muncul, upload galeri foto).
