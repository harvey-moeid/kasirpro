# PROSES.md — Rangkuman Pengerjaan

Log kerja proyek penggabungan kasire (kasir/POS) + etalase (toko online).
Ditulis untuk diri sendiri (Claude) & Harvey supaya bisa lanjut kerja tanpa
baca ulang seluruh riwayat chat.

## Status saat ini
- Sandbox: `/home/claude/merged/{kasire,etalase}` + `ARSITEKTUR.md`,
  `DEPLOY-BARU.md`, `TEMA.md`, `PROSES.md` (file ini) di root.
- Backend: kasire & etalase 0 error TypeScript. Migrasi SQL jalan bersih.
- Belum di-zip (nunggu diminta).

## Kronologi

1. **Upload awal**: `kas-main` (kasir/POS, Hono+D1+R2) & `toko-main`
   (etalase, Hono+D1+R2) — 2 project terpisah, 2 database terpisah.

2. **Gabung database jadi 1** — skema baru dari 0 (`0001_init.sql`),
   bukan hasil ALTER. Tabel `produk`/`kategori` dipakai bersama. Stok
   cuma ditulis kasir (single source of truth), etalase baca saja.

3. **Deploy baru dari 0** (bukan migrasi data production lama) — rename
   project jadi `kasire` & `etalase`, D1+R2 baru (bukan reuse yang lama).

4. **Review jujur #1** (diminta eksplisit "jangan bohong") — ketemu &
   perbaiki: cap 200 produk salah scope (per-toko harusnya global), API
   publik bocorin angka stok asli, tombol toggle status di admin nyasar
   (baca stok tulis tampil_online), kode_produk tanpa cek unik, etalase
   tanpa global error handler.

5. **1 domain, path routing** — etalase pegang root (`/`), kasire pindah
   ke `/kasir` di domain yang sama (Cloudflare Routes, BUKAN Custom
   Domain). `run_worker_first` dipakai supaya kasire bisa strip prefix
   sebelum serve asset/API. ~650 class Tailwind di-mapping manual dari
   path absolut ke `API_BASE`-relative. Ketemu & perbaiki bug: `<base>`
   href kacau, komentar sisa API_BASE salah, dsb.

6. **Tema premium dark+gold** — etalase (CSS variables, sudah ada
   fondasi navy+gold dari awal, tinggal invert basisnya jadi gelap).
   Kasire (Tailwind, bikin skema warna `ink` baru + mapping manual per
   class, BUKAN invert scale slate langsung krn slate-800/900 sudah
   dipakai buat elemen gelap yg sengaja). Ketemu & perbaiki: role
   conflict `--paper`/`--navy-900` dipakai dobel (bg vs text), bug
   regex sendiri (collision `color:`/`border-color:`), `bg-white/NN`
   (overlay kaca di header gelap) ikut ke-mapping jadi gelap-di-atas-
   gelap (paling signifikan, 31 instance direvert).

7. **R2 digabung 1 bucket** — kasire pakai prefix `produk/`, etalase
   pakai `products/`/`etalase/` (tidak collision).

8. **Admin digabung total jadi 1 login** (akun `users` kasir, admin
   etalase terpisah dihapus). Backend kasire diperluas: produk +field
   etalase (slug/deskripsi_toko/harga_coret/tampil_online), kategori
   +slug+PUT/DELETE, galeri foto produk, `/api/etalase/settings`,
   `/api/etalase/orders`. Backend etalase dirampingkan total jadi
   PUBLIK-ONLY (hapus auth.ts, upload.ts, middleware, admin_users dkk
   dari skema, folder public/admin/). Tab "Etalase Online" baru di
   admin.html kasire.

9. **Rencana 5 domain, 1 database (multi-cabang)** — user minta saran.
   Direkomendasikan: **Opsi A** — 1 kasire pusat (1 login `admin_toko`
   per cabang, `super_admin` lihat semua), 5 Worker etalase terpisah
   (1x deploy per cabang, `STORE_TOKO_ID` beda-beda, `database_id` &
   `bucket_name` R2 SAMA/dipakai bersama). User setuju.

10. **Audit keamanan IDOR menyeluruh** (46 endpoint kasire, satu-satu) —
    hasil: mayoritas SUDAH aman dari sesi-sesi sebelumnya (ada komentar
    `FIX (security)` di kode lama). Ketemu 1 bug NYATA: endpoint galeri
    foto (yang BARU saya tambahkan sendiri) tidak cek kepemilikan toko
    sama sekali — admin_toko cabang mana pun bisa upload/hapus foto
    galeri produk cabang LAIN. Sudah diperbaiki (pakai helper
    `getProdukAtauTolak` yang sama dgn endpoint produk lain).

11. **`store_settings` & `orders` dibenahi jadi multi-cabang** —
    `store_settings` dari 1 baris tetap (`id=1`) jadi 1 baris PER
    `toko_id`. `orders` dapat kolom `toko_id`. Endpoint
    `/api/etalase/settings` & `/api/etalase/orders` di-scope: admin_toko
    otomatis kunci ke cabangnya, super_admin bisa pilih cabang (dropdown
    baru di tab Etalase Online, cuma muncul utk super_admin).

12. **Klarifikasi**: "super_admin cuma bisa setting 1 domain/1 worker"
    — dicek & dikonfirmasi SUDAH aman by design tanpa perlu ubah kode:
    `STORE_TOKO_ID` cuma ada di kode etalase (env var Cloudflare,
    di-set sekali pas `wrangler deploy`), TIDAK ADA di kasire sama
    sekali, tidak ada endpoint yang baca/tulis nilai itu. Panel admin
    cuma sentuh tabel `store_settings` (isi konten toko), beda total
    dari config Worker/routing.

13. **Audit lanjutan (log-aktivitas, reset-data)** — selesai dicek,
    keduanya SUDAH di-scope toko_id dengan benar (reset-data malah
    sudah ada pengaman frasa konfirmasi + super_admin wajib pilih
    toko_id eksplisit).

14. **Pengaturan aplikasi (judul + struk) jadi per-cabang** — tabel
    `pengaturan` diubah dari key/value global (PK=key) jadi PK
    (toko_id, key), cabang baru mulai dari default sistem kosong (bukan
    warisan cabang lain). `admin_toko` sekarang boleh ubah pengaturan
    ini (dulu super_admin-only), tapi terkunci ke cabangnya sendiri.
    `super_admin` tetap bisa kelola semua cabang + dropdown pilih
    cabang (pola sama dgn Etalase Online). Tab baru "Pengaturan" di
    admin.html (dipisah dari "Kelola Toko" yang tetap super_admin-only).
    `GET /api/settings` jadi soft-auth (dipakai jg oleh login.html
    SEBELUM login → tanpa sesi = default sistem generik "KASIR CLOUD",
    baru setelah login ikut toko_id masing-masing).

15. **Brand/logo di-upgrade jadi "muidsoft"** (upload `muidsoft-brand-assets.zip`)
    — favicon (ico/svg/apple-touch-icon) ditambah di kasire (3 halaman)
    & etalase (belum pernah punya favicon sebelumnya). PWA icon
    (icon-192/icon-512) diganti. 3 badge brand-mark generik (ikon
    fa-store di gold badge, login/index/admin) diganti gambar mark "M"
    muidsoft asli. manifest.json theme_color/background_color
    disinkronkan ke navy gelap (masih ketinggalan #2563eb lama).
    sw.js APP_SHELL + cache version dinaikkan (v23) supaya asset baru
    ke-cache ulang. File sumber SVG disimpan di `brand-assets/` (root
    sandbox) buat referensi/reprint nanti.

16. **Test E2E sungguhan** — pakai `wrangler dev --local --persist-to <shared-dir>`
    (simulasi penuh Workers+D1+R2 lokal, TIDAK butuh akun Cloudflare),
    kedua Worker (kasire port 8787, etalase port 8788) dijalankan
    barengan nunjuk ke state lokal yang SAMA (simulasi 1 database
    beneran, bukan cuma baca kode). Hasil:
    - **Bug nyata ketemu & diperbaiki**: login 500 di lokal krn
      `JWT_SECRET` belum di-set — ternyata `wrangler secret put` cuma
      utk remote, testing lokal butuh file `.dev.vars` terpisah. Ini
      celah dokumentasi (DEPLOY-BARU.md belum sebut ini), BUKAN bug
      produksi (secret di server sungguhan diset via `wrangler secret
      put` seperti biasa).
    - **Terverifikasi BENERAN jalan** (bukan cuma baca kode lagi):
      auth wajib di endpoint produk (401 tanpa login), fix IDOR galeri
      foto dari sesi sebelumnya (403 lintas cabang, 200 cabang sendiri,
      dites pakai akun admin_toko sungguhan yang baru dibuat), admin_toko
      TIDAK BISA spoof toko_id lewat body request di PUT
      /api/etalase/settings (dipaksa server pakai toko_id sesi), etalase
      baca produk dari DB yang sama (5 dari 6 produk tampil sesuai
      tampil_online), field `stok` mentah TIDAK ikut ke JSON publik.
    - **Belum sempat dites** (lingkungan sandbox jadi tidak stabil di
      tengah sesi — proses `wrangler dev` sering gagal start/timeout
      setelah beberapa kali jalan, kemungkinan resource sandbox
      terpakai banyak dari sesi panjang ini): stok jadi 0 → otomatis
      hilang dari etalase (real-time), checkout WA nulis `toko_id` yang
      benar di tabel `orders`. Kedua ini SANGAT MUNGKIN benar (sudah
      diverifikasi lewat baca kode: query publik etalase filter
      `stok > 0`, endpoint checkout bind `c.env.STORE_TOKO_ID`
      langsung) tapi belum ada bukti empiris runtime seperti yang lain.

17. **Setting tampilkan/sembunyikan tab admin** — 2 lapis: (a) kebijakan
    per-cabang (`pengaturan` key `admin_tabs_enabled`, super_admin-only
    set, tidak membatasi super_admin sendiri di cabang manapun), (b)
    preferensi pribadi per-akun (kolom baru `users.hidden_tabs`, siapa
    saja atur punya sendiri). Murni tampilan (sesuai keputusan) — API
    endpoint tab yg disembunyikan TETAP bisa diakses langsung, tidak ada
    pembatasan akses tambahan. UI: 2 card checklist baru di tab
    "Pengaturan". `applyTabVisibility()` dipanggil sekali di `checkAuth()`,
    irisan (cabang policy ∩ NOT personal hidden), fallback ke dashboard
    kalau semua kesembunyi.

18. **Multi-tenant SaaS (toko_pusat → cabang → user)** — perubahan besar:
    ditambah level BARU di atas `toko` (cabang): `toko_pusat` (1 baris =
    1 pelanggan/bisnis, saling isolasi total). `super_admin` yang
    SEBELUMNYA global (lihat SEMUA data di database) sekarang dikunci
    ke `toko_pusat_id`-nya sendiri. Skema: tabel baru `toko_pusat`,
    kolom baru `toko.toko_pusat_id` & `users.toko_pusat_id`,
    `kategori.toko_pusat_id` (dulu global lintas SEMUA toko, sekarang
    per-tenant). JWT session bawa `toko_pusat_id`.

    **Audit ulang MENYELURUH** ~20 endpoint yang punya cabang logic
    "super_admin bebas akses" — HAMPIR SEMUA ternyata bocor lintas
    tenant kalau tidak diperbaiki (super_admin Tenant A bisa lihat/ubah
    data Tenant B). Bug PALING PARAH: helper `getProdukAtauTolak`
    (dipakai 6+ endpoint: edit/hapus produk, koreksi stok, galeri foto)
    SAMA SEKALI tidak cek tenant utk super_admin — 1 baris kode itu
    yang bikin bocor di banyak tempat sekaligus. Endpoint lain yang
    diperbaiki: GET/POST/PUT /api/toko, GET/POST /api/users, PUT
    /api/users/:id (super_admin bisa reset password/nonaktifkan akun
    TENANT LAIN), GET /api/produk (list tanpa toko_id = tampil semua
    tenant), 5 endpoint /api/laporan/* (laporan keuangan tercampur
    antar-bisnis!), GET /api/shift, GET/POST/PUT/DELETE /api/kategori,
    GET /api/transaksi + /api/transaksi/:id, POST
    /api/transaksi/:id/batalkan + /retur, GET /api/log-aktivitas, dan
    **endpoint reset-data (paling berbahaya — bisa hapus TOTAL data
    tenant lain tanpa validasi apa pun sebelum diperbaiki)**. Juga
    diperbaiki: cap 200 produk & proteksi "jangan nonaktifkan
    super_admin terakhir" yang tadinya itung GLOBAL lintas tenant
    (bug fungsional, bukan cuma keamanan).

    Divalidasi: migrasi jalan bersih, typecheck 0 error, simulasi SQL
    manual 2 tenant — Tenant A query toko cuma lihat cabangnya sendiri,
    tidak ada cabang Tenant B ikut muncul.

    **BELUM diperbaiki** (kompleksitas lebih tinggi, beda kelas —
    bukan kebocoran data rahasia, cuma soal kuota adil): cap 500MB R2
    masih itung total bucket GLOBAL lintas tenant (tenant A penuh bisa
    nge-block upload tenant B). Perlu tabel counter per-tenant atau
    restrukturisasi key R2 pakai prefix toko_pusat_id + listing by
    prefix. Juga: belum ada UI/endpoint utk BIKIN toko_pusat baru +
    super_admin pertamanya (asumsi: operasi manual SQL oleh pemilik
    platform, bukan self-service signup — perlu dikonfirmasi ke user
    kalau mau dibikin proper).

    **Ditemukan tambahan setelah dokumentasi awal ditulis**: endpoint
    publik `GET /api/categories` di ETALASE (bukan cuma kasire) juga
    bocor — query tanpa scoping sama sekali, jadi pengunjung toko online
    Tenant A akan melihat nama kategori milik TENANT LAIN tercampur di
    filter kategori. Diperbaiki pakai JOIN ke `toko` supaya bisa
    turunkan `toko_pusat_id` dari `STORE_TOKO_ID` milik deployment itu.

19. **Kuota R2 dibatasi per-tenant** (diminta: "batasi r2 per domain atau
    per worker"). Sebelumnya kuota 500MB dihitung SCAN SELURUH BUCKET
    (lintas semua tenant). Sekarang: key R2 direstruktur pakai prefix
    `produk/{toko_pusat_id}/...` & `etalase/{toko_pusat_id}/...`, kuota
    dihitung lewat R2 list-by-prefix (`hitungTotalUkuranR2UntukTenant`,
    2 prefix dijumlah) — jauh lebih cepat (tidak scan lintas tenant) &
    kuota kini benar-benar per-tenant, bukan per-domain/per-worker
    (domain/worker itu sendiri tidak relevan sbg unit kuota karena 1
    tenant bisa punya banyak Worker etalase; unit yang benar adalah
    toko_pusat_id). 3 titik upload diperbaiki: `/api/upload/produk`,
    `/api/produk/:id/galeri`, `/api/upload/etalase`.

20. **Bug dilaporkan dari deployment sungguhan** (screenshot user): menu
    akun di index.html (POS) tampil "undefined" bukan nama kasir.
    Penyebab: `currentUser.nama` (field TIDAK ADA di response API) vs
    field asli `currentUser.nama_lengkap` — 1 baris salah ketik field
    name, sisanya di file yang sama sudah benar pakai `nama_lengkap`.
    Diperbaiki, sudah disapu ulang tidak ada instance lain yang sama.

21. **Header popup menu akun diganti** — dari nama kasir jadi label
    generik "Menu Akun" (permintaan user, bukan bug).

## Yang BELUM dikerjakan / perlu tindak lanjut

- **Belum ditest visual di browser sama sekali** (sandbox tidak punya
  browser/screenshot). Semua validasi lewat: tsc --noEmit, build
  Tailwind, migrasi SQLite lokal, `node --check` buat sintaks JS, dan
  pembacaan kode manual. Rekomendasi: setelah deploy pertama, test
  MANUAL semua fitur, terutama tab "Etalase Online" (paling baru,
  belum pernah "putaran kedua" review kayak bagian lain).
- Belum ada langkah konkret "buat 5 baris toko + deploy 5 Worker
  etalase" yang benar-benar dieksekusi (baru didokumentasikan caranya
  di ARSITEKTUR.md §6) — Harvey yang eksekusi sendiri saat deploy
  sungguhan (butuh akun Cloudflare, tidak bisa dari sandbox ini).
- Field `store_settings.toko_id` ada FK ke `toko(id)` — belum ada
  validasi UI kalau toko_id yang dipilih ternyata belum punya baris
  `store_settings` (harusnya sudah ditangani via `INSERT ... ON
  CONFLICT DO UPDATE`, tapi belum dicoba end-to-end).

## Struktur file penting
```
kasire/src/index.ts          — backend utama, semua endpoint (termasuk etalase mgmt)
kasire/public/admin.html     — panel admin (1 login, tab "Etalase Online" baru)
kasire/migrations/0001_init.sql — skema DB (source of truth, identik dgn etalase/migrations/)
etalase/src/routes/*.ts      — publik-only sekarang (products, categories, settings, orders, images)
ARSITEKTUR.md                — penjelasan arsitektur + hasil audit keamanan
DEPLOY-BARU.md               — langkah deploy dari 0
TEMA.md                      — sistem warna/tema premium dark+gold
```
