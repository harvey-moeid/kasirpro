> ⚠️ **CATATAN:** Dokumen ini ditulis untuk project lama bernama `kas` (database/bucket `kas`). Worker ini sekarang bernama **`kasire`**, dan database/bucket-nya juga baru (`kasire`) — BUKAN `kas`. Untuk langkah deploy yang benar & terbaru, pakai `DEPLOY-BARU.md` di root folder, bukan panduan di bawah ini.

# KASIR CLOUD — Final Version

Sistem kasir (POS) berbasis **Cloudflare Workers + D1**, satu Worker melayani
backend (Hono) sekaligus frontend statis. Mendukung banyak toko/cabang,
peran (`super_admin` / `admin_toko` / `kasir`), mode offline dengan antrian
IndexedDB, panel admin (dashboard, kelola produk, kelola kasir, export Excel),
dan bisa dipasang sebagai PWA (installable, app-shell tetap terbuka saat
sinyal hilang).

Ini adalah **versi final** hasil konsolidasi dari beberapa iterasi
restrukturisasi sebelumnya. Ringkasan apa yang digabung & disempurnakan ada
di bagian [Riwayat & keputusan desain](#riwayat--keputusan-desain) di bawah.

## Struktur folder

```
kasir-cloud-pos/
├── src/
│   ├── index.ts                ← Backend Hono (satu-satunya sumber kebenaran)
│   └── lib/
│       ├── crypto.ts           ← hash password (PBKDF2+salt) & session token (HMAC, signed+verified)
│       └── auth-middleware.ts  ← requireAuth() & requireRole()
├── migrations/                  ← 9 file, WAJIB dijalankan berurutan (lihat DEPLOY.md §5)
│   ├── 0001_init.sql               ← schema inti + seed data (toko, admin/kasir demo, produk contoh)
│   ├── 0002_split_payment.sql      ← tabel transaksi_pembayaran (bayar >1 metode sekaligus)
│   ├── 0003_shift_kasir.sql        ← tabel shift_kasir (buka/tutup shift, rekonsiliasi kas)
│   ├── 0004_log_aktivitas.sql      ← tabel log_aktivitas (audit trail aksi admin)
│   ├── 0005_pengaturan.sql         ← tabel pengaturan (key/value, judul aplikasi dll)
│   ├── 0006_laba_dan_struk.sql     ← kolom hpp_satuan + kustomisasi struk
│   ├── 0007_struk_ikon.sql         ← pilihan ikon footer struk (QR code/nama toko)
│   ├── 0008_diskon_item.sql        ← kolom diskon_item (diskon per-baris di keranjang)
│   ├── 0009_retur.sql              ← qty_retur/subtotal_retur + tabel retur & retur_item
│   └── 0010_retur_metode_pengembalian.sql ← retur.metode_pengembalian (cash/non_cash, akurasi kas shift)
├── public/
│   ├── login.html               ← form login, redirect otomatis sesuai role
│   ├── index.html                ← halaman kasir (POS), offline-first (IndexedDB queue)
│   ├── admin.html                ← dashboard, kelola produk/kasir/toko, riwayat transaksi, export Excel
│   ├── manifest.json              ← PWA manifest (installable)
│   ├── sw.js                       ← service worker (cache app-shell, bukan API)
│   └── icons/                       ← ikon PWA 192x192 & 512x512
├── scripts/
│   └── gen-password-hash.mjs   ← generate hash+salt password baru (PBKDF2, sama dgn crypto.ts)
├── wrangler.toml                ← konfigurasi Worker + D1 + R2 + static assets
├── package.json
└── tsconfig.json
```

## Fitur baru: Split Payment & Cetak Struk

- **Split payment**: satu transaksi bisa dibayar dengan >1 metode sekaligus
  (mis. sebagian tunai + sebagian QRIS). Pilih tombol **SPLIT** di halaman
  kasir, tambahkan baris metode+jumlah sebanyak yang dibutuhkan. Aturan:
  kembalian hanya dihitung dari porsi **tunai** (metode digital seperti
  QRIS/debit/transfer tidak punya "kembalian" fisik), dan divalidasi baik di
  frontend maupun di server (`hitungSplitPayment()` di `src/index.ts`).
  Rinciannya tersimpan per-baris di tabel baru `transaksi_pembayaran`
  (lihat `migrations/0002_split_payment.sql`) — **wajib jalankan migrasi ini**
  sebelum deploy, selain `0001_init.sql`:
  ```bash
  npm run db:migrate:local:split   # atau
  npm run db:migrate:remote:split
  ```
- **Cetak struk**: fokus ke cetak langsung ke printer thermal Bluetooth
  (ESC/POS via Web Bluetooth API) — tombol "Cetak Struk" di modal struk.
  Opsi cetak lewat dialog print browser (`window.print()`) sudah dihapus;
  hanya jalur Bluetooth langsung yang dipertahankan. Catatan kompatibilitas:
  Web Bluetooth API hanya didukung Chrome/Edge di Android & Desktop — Safari/
  iOS tidak mendukungnya sama sekali (akan muncul pesan error yang jelas,
  bukan gagal diam-diam).

## Fitur baru: Upload Foto Produk

Form produk di panel admin sekarang punya 2 cara mengisi foto:

- **Upload dari perangkat** — tombol "Upload dari perangkat" membuka pemilih
  file (kamera/galeri di HP). Gambar otomatis di-**resize & dikompres di
  browser** (maks 1000px sisi terpanjang, JPEG kualitas 82%) sebelum diupload,
  supaya foto dari kamera HP (bisa 4-8MB) tidak membebani upload/storage.
  File disimpan di **Cloudflare R2** lewat `POST /api/upload/produk`, lalu
  diserve balik lewat `GET /api/gambar/:key` dari Worker yang sama (tidak
  perlu setup akses publik R2 terpisah). Validasi di server: hanya
  JPG/PNG/WEBP, maks 2MB, dan hanya role admin yang boleh upload.
- **Tempel URL** — opsi lama (gambar yang sudah di-hosting di tempat lain)
  tetap ada, tinggal isi kolom URL seperti biasa.

Saat foto produk diganti (upload baru menggantikan yang lama), foto lama di
R2 **otomatis dihapus** (best-effort, tidak menggagalkan penyimpanan produk
kalau gagal) supaya bucket tidak terus membengkak dengan foto yatim.

**Wajib dilakukan sebelum deploy** — buat bucket R2-nya (sekali saja, lihat
langkah 3b di `DEPLOY.md`):
```bash
npx wrangler r2 bucket create kas
```

## Fitur utama

- **Autentikasi aman**: password di-hash PBKDF2-SHA256 (100.000 iterasi) +
  salt unik per user, dibandingkan dengan `timingSafeEqual`. Login selalu
  menjalankan verifikasi (walau user tidak ditemukan) untuk mencegah timing
  attack yang membocorkan username valid.
- **Sesi berbasis cookie HttpOnly + Secure + SameSite=Strict**, token
  ditandatangani HMAC-SHA256 (mirip JWT) dan diverifikasi signature +
  expiry-nya di setiap request (bukan cuma di-sign lalu dipercaya begitu saja).
- **Kontrol akses per-role** (`requireAuth` + `requireRole`) di setiap
  endpoint sensitif, termasuk validasi kepemilikan toko di level server (admin
  toko A tidak bisa mengubah data toko B meski mencoba lewat request manual).
- **Transaksi atomik** lewat `db.batch()` — header transaksi, detail item, dan
  update stok semua sukses bersama atau di-rollback bersama oleh D1. Query
  stok produk diambil sekali di awal (bukan N+1 di dalam loop).
- **Idempotency lewat `offline_uuid`** — transaksi yang disinkronkan ulang
  dari antrian offline tidak akan pernah tercatat dobel di server.
- **Mode offline**: transaksi kasir yang gagal terkirim (sinyal hilang
  sungguhan) otomatis masuk antrian IndexedDB di browser, lalu disinkronkan
  otomatis begitu koneksi kembali. Status online/offline murni dari
  `navigator.onLine` + event `online`/`offline` browser (bukan toggle
  simulasi manual) — badge di header selalu jujur menampilkan jumlah
  transaksi pending selama masih ada antrian, walau koneksi saat ini
  terlihat baik-baik saja. Retry sync memakai **exponential backoff** (10
  detik → 20 → ... maksimal 5 menit, reset begitu sync sukses penuh) supaya
  tidak spam request kalau internet mati lama, plus retry periodik tiap 30
  detik di background supaya antrian tidak nyangkut menunggu aksi kasir.
  Detail cakupan & batasannya ada di bagian
  [Cara kerja mode offline](#cara-kerja-mode-offline) di bawah.
- **PWA installable**: `manifest.json` + `sw.js` meng-cache app-shell
  (HTML/CSS/font/ikon) dengan strategi cache-first + background-refresh,
  supaya aplikasi tetap bisa dibuka instan walau offline. Endpoint `/api/*`
  sengaja **tidak** disentuh service worker — logic offline-queue di
  `index.html` yang menangani, agar `offline_uuid` tetap satu-satunya sumber
  kebenaran untuk mencegah duplikasi.
- **Panel admin** (`admin.html`, role `super_admin`/`admin_toko`):
  - Dashboard: total penjualan & transaksi hari ini, produk terlaris, stok
    menipis (ambang bisa diubah), semua dengan filter rentang tanggal.
  - **Export Excel** 3-sheet (Transaksi, Produk Terlaris, Stok Menipis) murni
    di browser lewat SheetJS — tidak menyentuh backend.
  - Kelola produk: tambah/edit/nonaktifkan (soft delete), pencarian, modal
    **Koreksi Stok** terpisah (wajib diisi alasan, tercatat di `riwayat_stok`),
    dan tombol **"Scan untuk Tambah"** — 1 tap buka form kosong + langsung
    nyalakan kamera untuk scan barcode, dengan pengecekan duplikat otomatis
    (kalau barcode sudah dipakai produk lain, diarahkan ke form edit produk
    itu alih-alih membuat duplikat).
  - Kelola kasir: tambah user, edit nama/status/reset password, kolom
    **status shift real-time** ("Sedang kerja"/"Tidak aktif") supaya admin
    tahu siapa yang sedang bertugas tanpa buka menu Shift terpisah.
  - **Riwayat Transaksi**: list transaksi + filter tanggal, detail per item,
    dan dua aksi — **Batalkan** (all-or-nothing) atau **Retur per-item**
    (lihat bagian di bawah).
  - **Zona Berbahaya** (tab Kelola Toko): tombol **Reset Data Toko** untuk
    menghapus semua produk/transaksi/shift/riwayat stok satu toko sekaligus
    (user & data toko tidak ikut terhapus) — berguna membersihkan data
    demo/uji coba sebelum benar-benar dipakai. Wajib ketik ulang frasa
    konfirmasi persis, tidak bisa dibatalkan setelah dieksekusi.
  - `super_admin` bebas pilih toko; `admin_toko` otomatis terbatas ke tokonya
    sendiri — divalidasi ulang di server, bukan cuma disembunyikan di UI.
  - Kalau login sebagai admin lewat halaman kasir (`index.html`), ada tombol
    **"Dashboard Admin"** di menu akun untuk langsung pindah ke panel admin
    tanpa perlu ganti URL manual (kasir murni tidak melihat tombol ini).
- **Satu Worker untuk semuanya** — `[assets]` di `wrangler.toml` menyajikan
  seluruh isi `public/` langsung dari edge Cloudflare (tanpa menyentuh kode
  Worker sama sekali untuk request statis); `/api/*` diteruskan ke `src/index.ts`.
  Tidak perlu setup Cloudflare Pages terpisah, tidak ada isu CORS antar domain.
- **Diskon per-item**: selain diskon total transaksi, kasir bisa memberi
  diskon nominal (Rupiah) pada baris item tertentu di keranjang (tombol
  "Diskon item" di tiap baris). Divalidasi di server (tidak boleh melebihi
  harga baris tersebut) dan disimpan di kolom `detail_transaksi.diskon_item`
  (migrasi 0008) — laporan laba otomatis ikut benar karena `subtotal` yang
  tersimpan sudah bersih dari diskon ini.
- **Riwayat Transaksi & Retur** (tab baru di admin panel): sebelumnya
  endpoint `GET /api/transaksi`, `GET /api/transaksi/:id`, dan
  `POST /api/transaksi/:id/batalkan` sudah ada di backend sejak awal tapi
  TIDAK ADA UI yang memanggilnya sama sekali. Sekarang ada tab "Riwayat
  Transaksi" — list transaksi dengan filter tanggal, klik untuk lihat detail
  item, dan dua aksi:
  - **Batalkan Transaksi**: all-or-nothing, seluruh transaksi (tombol lama
    yang akhirnya tersambung ke UI).
  - **Retur per-item** (fitur baru, migrasi 0009): pilih sebagian item +
    qty untuk diretur, stok otomatis kembali, `transaksi.total_bayar`
    dikurangi proporsional. Data asli `detail_transaksi` TIDAK diubah (tetap
    arsip apa yang benar-benar terjadi) — retur dicatat di kolom kumulatif
    `qty_retur`/`subtotal_retur` terpisah + tabel `retur`/`retur_item` untuk
    audit trail (kapan, siapa, kenapa). Laporan laba & produk terlaris
    otomatis mengurangi angka retur tanpa perlu ubah cara baca laporannya.
  - **Retur dari sisi kasir**: kasir juga bisa proses retur transaksinya
    sendiri langsung dari layar kasir (menu akun → "Retur Transaksi"), tidak
    perlu lewat admin panel. Sebagai pengaman, kasir wajib konfirmasi ulang
    PASSWORD MILIKNYA SENDIRI sebelum retur diproses (re-autentikasi
    identitas, bukan persetujuan/pengawasan atasan). Kasir cuma bisa akses
    transaksi miliknya sendiri. admin_toko/super_admin yang memakai layar
    kasir langsung tidak perlu konfirmasi ini.
- **Batas langganan** (global, gabungan SEMUA toko — bukan per-toko):
  - Maksimal **200 produk aktif** (produk yang dinonaktifkan tidak
    dihitung). Dicek di `POST /api/produk` sebelum insert.
  - Maksimal **500MB total penyimpanan gambar** di R2. Dicek di
    `POST /api/upload/produk` sebelum upload — dihitung live lewat
    `R2.list()` (bukan counter terpisah di DB, supaya selalu akurat &
    self-healing walau ada upload/hapus yang gagal setengah jalan).
  - Kalau limit tercapai, request ditolak (403) dengan pesan minta upgrade
    langganan. Konstanta `PRODUK_MAX_TOTAL` & `R2_MAX_BYTES_TOTAL` di
    `src/index.ts` kalau perlu diubah nanti.
- **Geo-restriction** (opsional, Indonesia-only) dikontrol lewat env var
  `ENFORCE_GEO`, bukan hardcode — bisa dimatikan saat development/testing.

## Langkah deploy (ringkas)

Panduan lengkap step-by-step ada di [`DEPLOY.md`](./DEPLOY.md). Ringkasan cepat:

```bash
npm install

# 1. Buat database D1 (sekali saja)
npx wrangler d1 create kas
# → copy "database_id" hasilnya ke wrangler.toml

# 2. Buat bucket R2 untuk foto produk (sekali saja)
npx wrangler r2 bucket create kas

# 3. Jalankan SEMUA migration berurutan (schema + seed data demo) — lihat
#    DEPLOY.md §5 untuk daftar lengkap 9 file & apa fungsi masing-masing
npm run db:migrate:remote
npm run db:migrate:remote:split
npm run db:migrate:remote:shift
npm run db:migrate:remote:log
npm run db:migrate:remote:settings
npm run db:migrate:remote:laba
npm run db:migrate:remote:strukikon
npm run db:migrate:remote:diskonitem
npm run db:migrate:remote:retur
npm run db:migrate:remote:returmetode

# 4. Set JWT secret (JANGAN taruh di wrangler.toml)
npx wrangler secret put JWT_SECRET
# isi dengan string acak panjang, misal hasil dari: openssl rand -base64 32

# 5. Deploy (backend + frontend sekaligus, satu Worker)
npm run deploy
```

Buka `https://<subdomain-anda>.workers.dev/login.html` — sudah live.

### Development lokal

```bash
cp .dev.vars.example .dev.vars   # isi JWT_SECRET untuk lokal
npm run db:migrate:local
npm run dev                       # http://localhost:8787
```

## Akun demo (dari seed data)

| Username | Password  | Role        |
|----------|-----------|-------------|
| admin    | admin123  | super_admin |
| kasir1   | kasir123  | kasir       |

**Wajib ganti password ini sebelum go-live**:
```bash
node scripts/gen-password-hash.mjs "passwordBaruAnda"
```
lalu jalankan:
```bash
npx wrangler d1 execute kas --remote --command "UPDATE users SET password_hash='HASH', password_salt='SALT' WHERE username='admin'"
```

## Cara kerja mode offline

Ringkasan **apa yang tetap bisa dipakai** dan **apa yang butuh koneksi**:

| Aksi | Butuh koneksi? |
|---|---|
| Membuka halaman kasir yang sudah pernah dibuka sebelumnya (app-shell) | ❌ Tidak — di-cache service worker (PWA) |
| Melihat daftar produk yang sudah pernah dimuat | ❌ Tidak — tersimpan di memori/cache browser |
| **Checkout/transaksi**, kalau kasir sudah punya shift aktif terkonfirmasi | ❌ Tidak — otomatis masuk antrian IndexedDB, disinkronkan begitu online lagi |
| **Membuka shift baru** (pertama kali jualan) | ✅ Ya — perlu server untuk memastikan tidak ada shift ganda/ambigu |
| **Menutup shift** | ✅ Ya — kas sistem final dihitung server dari seluruh transaksi shift |
| Login pertama kali di perangkat itu | ✅ Ya — sesi & password diverifikasi server |
| Panel admin (produk, kasir, laporan) | ✅ Ya — tidak didesain offline-first, dipakai oleh admin toko yang biasanya online |

Poin pentingnya: **kalau kasir sudah mulai shift dalam kondisi online**, mereka
bisa terus jualan walau koneksi tiba-tiba putus di tengah jalan — transaksi
antre otomatis, badge kas menampilkan status "(offline)" dari data terakhir
yang diketahui, dan semuanya tersinkronisasi begitu koneksi kembali. Yang
**tidak bisa** dilakukan offline hanyalah memulai shift yang benar-benar baru
dari nol (wajar — sistem tidak mungkin memastikan tidak ada shift ganda tanpa
bertanya ke server) dan aksi-aksi admin (yang memang tidak didesain untuk
dipakai di lapangan tanpa sinyal).

## Rate limiting login (lewat Cloudflare Dashboard, bukan kode)

Sengaja **tidak** diimplementasikan manual di dalam Worker, karena Cloudflare
punya fitur native (WAF → Rate limiting rules) yang berjalan di edge —
sebelum request bahkan sampai ke Worker, jadi lebih hemat & lebih cepat
memblokir brute force dibanding rate-limit manual pakai KV/Durable Object.

1. **Cloudflare Dashboard → domain Anda → Security → WAF → Rate limiting rules → Create rule**
2. Kondisi: `URI Path equals /api/auth/login` (tambahkan `Request Method equals POST` jika mau lebih spesifik)
3. Karakteristik: `IP Address`, Period `1 menit`, Requests `5`
4. Saat limit terlampaui: `Block` (atau `Managed Challenge`) selama `10 menit`
5. **Deploy**

> Butuh paket Cloudflare Pro ke atas untuk beberapa opsi lanjutan. Di paket
> Free, alternatif: pasang **Cloudflare Turnstile** (captcha invisible) di
> `login.html`.

## Riwayat & keputusan desain

Proyek ini melalui beberapa kali restrukturisasi dari kode awal yang punya dua
backend tumpang-tindih (`index.ts` & `worker.ts` lama, logic berbeda & sama-sama
tidak lengkap) serta frontend yang masih 100% simulasi. Versi final ini
menggabungkan perbaikan-perbaikan berikut:

1. **Backend digabung jadi satu** (`src/index.ts`) — sumber kebenaran tunggal.
2. **Backdoor login dihapus sepenuhnya** — sebelumnya `password === '123'`
   atau `password === user.password_hash` (plaintext) selalu diterima.
3. **PBKDF2-SHA256 + salt asli** menggantikan penyimpanan password apa adanya;
   kolom `password_salt` ditambahkan ke skema.
4. **Middleware auth & role** (`requireAuth`, `requireRole`) dipasang di semua
   endpoint sesuai matriks role — sebelumnya semua endpoint publik tanpa cek sesi.
5. **CORS dipindah ke urutan paling atas**, sebelum geo-restriction, agar
   preflight `OPTIONS` tidak ikut terblokir 403.
6. **`db.batch()` untuk transaksi** — atomicity terjamin, `riwayat_stok`
   tercatat otomatis, query stok tidak lagi N+1 per item.
7. **`kode_transaksi`/`offline_uuid`** memakai kombinasi timestamp+random dan
   `UNIQUE` constraint — bukan `Math.random()*100` yang rawan collision — plus
   idempotency check eksplisit untuk sinkronisasi offline.
8. **`JWT_SECRET` dipindah dari `wrangler.toml` plaintext** ke
   `wrangler secret put` (produksi) / `.dev.vars` (lokal, sudah di-gitignore).
9. **`compatibility_flags = ["nodejs_compat"]`** menggantikan `node_compat`
   yang sudah deprecated.
10. **Frontend disambungkan ke API asli** — login, daftar produk, checkout,
    dan sinkronisasi antrian offline semua memakai `fetch()` sungguhan dengan
    `credentials: 'include'`, menggantikan simulasi `setTimeout`/data hardcoded.
11. **Auth guard di halaman kasir & admin** — redirect otomatis ke
    `login.html` jika sesi tidak valid, dicek lewat `GET /api/auth/me`.
12. **Panel admin & export Excel** ditambahkan lengkap (dashboard, kelola
    produk/kasir, koreksi stok dengan audit trail).
13. **Konsolidasi final**: backend & frontend disatukan dalam satu Worker
    (`[assets]` di `wrangler.toml`) sehingga tidak perlu deploy Cloudflare
    Pages terpisah; `ENFORCE_GEO` dijadikan env var yang bisa dimatikan saat
    testing; **PWA** (`manifest.json` + `sw.js` + ikon) ditambahkan supaya
    aplikasi installable dan app-shell tetap terbuka saat offline.
14. **Hardening keamanan & integritas data multi-toko** *(perubahan versi ini)*:
    - **Harga transaksi tidak lagi dipercaya dari client** — `POST /api/transaksi`
      sekarang selalu mengambil ulang `harga_jual`, `nama`, `is_active`, dan
      `toko_id` dari tabel `produk` di DB sebelum menghitung subtotal; field
      `harga`/`nama` yang dikirim browser diabaikan sepenuhnya.
    - **Validasi `qty`** — harus bilangan bulat positif per item, ditolak kalau tidak.
    - **Produk nonaktif ATAU milik toko lain tidak bisa dibeli** — sebelumnya
      query stok tidak memfilter `is_active` maupun `toko_id`, jadi kasir toko A
      secara teknis bisa "membeli" produk toko B lewat request yang dimodifikasi
      manual. Sekarang keduanya divalidasi eksplisit sebelum transaksi diproses.
    - **Proteksi super_admin terakhir** — `PUT /api/users/:id` menolak permintaan
      menonaktifkan akun kalau itu akan membuat jumlah `super_admin` aktif
      menjadi 0, supaya panel admin tidak pernah terkunci total.
    - **Zona waktu WIB untuk semua laporan bertanggal** — `date(created_at)`
      (UTC mentah) diganti `date(datetime(created_at, '+7 hours'))` di
      `/api/laporan/harian`, `/api/laporan/produk-terlaris`,
      `/api/laporan/tren-penjualan`, dan `GET /api/transaksi`, supaya transaksi
      jam 00:00–06:59 WIB tidak tercatat ke tanggal yang salah.
    - **Ganti password sendiri** — endpoint baru `POST /api/auth/change-password`
      (butuh password lama) + UI-nya di `index.html` (menu akun di header) dan
      `admin.html` (ikon kunci di header).
15. **Fix kas sistem shift tidak memperhitungkan kembalian** *(perubahan versi ini)*:
    `GET /api/shift/aktif` dan `POST /api/shift/tutup` sebelumnya menghitung
    "kas sistem" hanya dari `SUM(transaksi_pembayaran.jumlah)` untuk metode
    cash — yaitu nominal yang **diserahkan** pelanggan (mis. bayar Rp50.000
    untuk tagihan Rp15.500), bukan nominal yang benar-benar tersisa di laci
    setelah kembalian diberikan. Akibatnya kas sistem selalu jauh lebih besar
    dari kas fisik sungguhan, dan kasir yang menutup shift dengan jujur akan
    selalu terlihat "kurang" sebesar total kembalian yang pernah diberikan.
    Sekarang kas sistem dihitung sebagai `total tunai diserahkan − total
    kembalian` (kembalian selalu berasal dari cash, sesuai aturan bisnis di
    `hitungSplitPayment()`), diverifikasi dengan transaksi tunggal, campuran
    cash+non-cash, dan split payment.
    ⚠️ **Shift yang SUDAH ditutup sebelum fix ini** tetap menyimpan
    `kas_sistem_akhir`/`selisih` yang salah (dihitung dengan rumus lama) —
    fix ini hanya berlaku untuk shift yang dibuka/ditutup setelah kode baru
    di-deploy. Riwayat shift lama tidak dikoreksi otomatis.
16. **Fix kasir terkunci total saat offline di tengah shift** *(perubahan versi ini)*:
    `checkShiftStatus()` sebelumnya memperlakukan "gagal fetch karena jaringan
    putus" SAMA PERSIS dengan "server konfirmasi tidak ada shift aktif" —
    keduanya sama-sama memicu modal blocking wajib buka shift (yang tidak
    punya tombol tutup), padahal `GET /api/shift/aktif` dipanggil ulang
    setelah **setiap transaksi** untuk refresh badge kas. Praktiknya: begitu
    koneksi terputus di tengah shift yang sedang aktif, kasir langsung
    terkunci total dari halaman kasir — bertentangan dengan antrian offline
    (IndexedDB) yang sudah ada untuk transaksinya sendiri.

    Sekarang status shift TERVERIFIKASI (hasil sukses dari server) disimpan di
    `localStorage`, di-scope per user login. Saat fetch gagal karena jaringan,
    aplikasi jatuh ke status terverifikasi terakhir itu alih-alih mengasumsikan
    "tidak ada shift" — modal blocking HANYA muncul kalau memang belum pernah
    ada shift terkonfirmasi sama sekali (mis. buka aplikasi pertama kali dalam
    kondisi offline, yang secara inheren tidak bisa diverifikasi tanpa server).
    Diverifikasi lewat 5 skenario (online+ada shift, offline+ada cache,
    offline+tanpa cache, online+konfirmasi tidak ada shift, setelah shift
    ditutup+offline) — semua berperilaku sesuai ekspektasi.
17. **Fix stored XSS & formula injection di panel admin/kasir** *(perubahan versi ini)*:
    - **Attribute-breakout XSS di tombol "Koreksi Stok" dan "Nonaktifkan"
      produk** (`admin.html`) — nama produk disisipkan ke atribut
      `onclick='...'` lewat `JSON.stringify()`, yang TIDAK aman untuk konteks
      atribut HTML (JSON pakai tanda kutip ganda, tapi tidak meng-escape
      tanda kutip satu). Nama produk sesederhana **"Teh Po'o"** (wajar, bukan
      serangan) sudah cukup merusak tombolnya; nama yang sengaja diisi payload
      bisa mengeksekusi JS di browser admin lain. Tombol "Nonaktifkan" bahkan
      sudah rusak untuk **hampir semua** nama produk sebelum fix ini, karena
      atribut luarnya juga pakai tanda kutip ganda — bentrok langsung dengan
      keluaran `JSON.stringify()`. Diperbaiki dengan pendekatan yang lebih
      aman daripada sekadar escaping: `openKoreksiModal()`/`hapusProduk()`
      sekarang hanya menerima `id`, lalu mencari data produk dari `produkList`
      yang sudah ada di memori — tidak pernah lagi membawa teks bebas lewat
      atribut HTML sama sekali.
    - **Stored XSS via `innerHTML` tanpa escaping** — nama produk, kategori,
      toko, username, dan kolom `keterangan` di log aktivitas dirender
      langsung ke `innerHTML` di puluhan tempat (`admin.html` & `index.html`)
      tanpa escaping. Ditambahkan helper `escapeHtml()` di kedua file dan
      diterapkan ke semua render tabel/dropdown/kartu produk/struk/keranjang
      yang menampilkan teks dari data (bukan dari kode).
    - **Formula injection di export Excel** — nama produk yang diawali
      `=`/`+`/`-`/`@` akan dibaca sebagai formula oleh Excel saat file laporan
      dibuka. Ditambahkan `sanitizeForExcel()` yang meng-prefix nilai
      semacam itu dengan apostrof (teknik standar OWASP), diterapkan ke semua
      kolom teks bebas di 3 sheet export.

    Diverifikasi dengan produk bernama `Teh Po'o <script>alert(1)</script>` —
    dibuat lewat API, backend menyimpannya apa adanya (memang tugas backend,
    bukan tempat sanitasi), lalu disimulasikan render aktualnya: hasilnya
    ter-escape sempurna jadi teks biasa, tombol aksi tetap berfungsi normal.
18. **Pola bug "spesifisitas CSS sama, cascade order menentukan"** *(perubahan
    versi ini)* — ditemukan **dua kali terpisah** dengan gejala berbeda, akar
    masalah sama persis:
    - **`#floating-cart` (bar Total Pembayaran) terdorong keluar layar** di
      mobile — `height:100vh` di `body`/`#app-col`/`#main-shell` dihitung dari
      viewport MAKSIMUM (seolah address bar browser disembunyikan), meleset
      dari area yang benar-benar terlihat. Percobaan fix pertama (tambah
      `height:100dvh` di rule `body{}`) **gagal diam-diam**: class Tailwind
      `.h-screen{height:100vh}` (spesifisitas class, 0-1-0) menang atas
      element-selector `body{}` (0-0-1) — class SELALU menang atas element
      selector terlepas urutan sumber. Fix sungguhan: hapus class `h-screen`
      dari `<body>`, biarkan `height:100dvh` di rule kustom yang mengontrol
      penuh tanpa lawan.
    - **Spinner loading di tombol login selalu tampil**, bukan cuma salah
      posisi seperti dikira awalnya — Font Awesome (CDN, dimuat SETELAH
      `/styles.css`) py rule dasar `.fas{display:...}` dengan spesifisitas
      SAMA (0-1-0) seperti `.hidden{display:none}` milik kita; karena sama
      persis, yang dimuat BELAKANGAN menang → CSS Font Awesome menang → ikon
      dengan class gabungan `fas ... hidden` tetap ter-render+berputar.
      Fix: `#btn-loader.hidden{display:none!important}` (spesifisitas
      id+class, 1-1-0) menang telak dari keduanya, terlepas urutan loading.

    Pelajaran: kalau override class utility (Tailwind atau sejenisnya) tidak
    kunjung "kelihatan bekerja" padahal kodenya sudah benar, curigai
    spesifisitas CSS yang setara + urutan cascade, bukan cuma cek ulang
    logikanya — terutama kalau ada library CSS pihak ketiga (icon font, dll)
    yang dimuat setelah stylesheet sendiri.
19. **Fix risiko tabrakan `kode_transaksi`** *(perubahan versi ini)* —
    ditemukan lewat perhitungan birthday paradox: generator kode lama (4
    digit acak, 9000 kemungkinan/hari) punya ~42% peluang TABRAKAN per hari
    untuk toko dengan 100 transaksi/hari (89% di 200/hari), dan sebelumnya
    tidak ada retry sama sekali saat itu terjadi — checkout gagal total
    dengan pesan error yang salah diagnosis (selalu dikira `offline_uuid`
    collision, padahal kolom UNIQUE yang berbeda). Fix: entropi dinaikkan ke
    6 digit (900rb kemungkinan/hari, turunkan ke ~0.55% di 100/hari) **plus**
    retry otomatis (maks 3 percobaan, deteksi spesifik dari nama kolom di
    pesan error SQLite/D1) sebagai jaring pengaman utama — entropi bukan
    solusi tunggal, probabilitas kecil tetap bukan nol.
20. **Fix alignment struk Bluetooth akibat non-breaking space** *(perubahan
    versi ini)* — `Intl.NumberFormat('id-ID', {style:'currency',...})` yang
    dipakai `formatRp()` di SEMUA nominal Rupiah ternyata menyisipkan
    non-breaking space (U+00A0) antara "Rp" dan angka, bukan spasi biasa —
    identik di layar, tapi saat di-encode UTF-8 untuk printer thermal jadi
    2-byte (bukan 1 byte spasi biasa), padahal perhitungan lebar kolom pakai
    `.length` (hitung karakter, bukan byte) — setiap baris struk yang
    mengandung nominal harga geser 1 byte dari yang dihitung. Printer
    thermal murah yang defaultnya codepage 1-byte (bukan UTF-8) berisiko
    malah mencetak karakter aneh. Fix: normalisasi `\u00a0` → spasi biasa di
    satu titik (`text()` dasar di `buildEscPosReceipt`) sebelum di-encode.
21. **Fix rekonsiliasi kas shift tidak memperhitungkan retur tunai**
    *(perubahan versi ini)* — ditemukan lewat simulasi angka nyata: endpoint
    retur cuma mengurangi `transaksi.total_bayar`, tidak pernah mencatat
    *bagaimana* uangnya dikembalikan ke pelanggan. Akibatnya kalkulasi kas
    sistem (`GET /api/shift/aktif`, `POST /api/shift/tutup`) tidak tahu ada
    uang TUNAI yang keluar dari laci akibat retur — kasir yang jujur
    menghitung kas fisik di akhir shift akan selalu terlihat "kurang"
    sebesar total retur tunai yang pernah terjadi selama shift itu, padahal
    bukan kesalahan mereka. Regresi dari kelas bug yang sama dengan item 15
    di atas, kali ini muncul dari fitur retur yang baru dibangun. Fix
    (migrasi 0010): tambah kolom `retur.metode_pengembalian` ('cash' atau
    'non_cash'), **wajib dipilih eksplisit** saat proses retur (tidak ada
    default diam-diam — salah asumsi di sini bikin rekonsiliasi meleset,
    lebih baik kasir/admin sadar memilih daripada sistem menebak). Kas
    sistem sekarang ikut mengurangi total retur yang metodenya 'cash'.
    Diverifikasi lewat 2 simulasi: retur tunai (kas sistem = kas fisik,
    cocok) dan retur non-tunai (kas sistem tidak berkurang, karena uangnya
    tidak keluar dari laci fisik).

### Catatan desain yang disengaja

- **Stok bisa menjadi negatif** akibat transaksi offline yang disinkronkan
  belakangan — transaksi tetap diterima (barang fisik sudah terjual), admin
  merekonsiliasi lewat laporan "stok menipis" & `riwayat_stok`. Ini bukan bug.
- Service worker (`sw.js`) **tidak pernah** meng-cache atau mengintersep
  request `/api/*` — hanya app-shell statis. Logic offline yang sesungguhnya
  (antrian transaksi) tetap sepenuhnya di tangan `index.html` + IndexedDB,
  supaya idempotency `offline_uuid` tidak pernah terganggu oleh cache SW.

### Keterbatasan yang diketahui (belum diperbaiki)

_(Tidak ada per saat ini — item sebelumnya di sini soal `PUT /api/users/:id` sudah diperbaiki, lihat komentar "FIX (security)" di kode.)_

