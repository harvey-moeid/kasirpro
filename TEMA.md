# Tema: Premium Dark + Gold

Status: **DRAFT di sandbox**. Berlaku untuk kedua aplikasi (kasire & etalase),
dibangun sebagai 1 keluarga visual yang selaras.

## Konsep

"Butik di malam hari" — latar navy nyaris hitam, aksen emas hangat, tipografi
serif/display untuk judul, sans-serif bersih untuk isi. Etalase mewarisi
motif "tiket belanja nota" yang sudah ada sebelumnya (garis perforasi,
font mono untuk angka) — cuma basisnya digeser dari krem terang ke navy gelap.

## Di mana ubah warnanya

**Etalase** (storefront publik — sudah tidak ada admin panel sendiri lagi,
lihat ARSITEKTUR.md §3 "Admin Digabung Jadi 1") — SEMUA warna lewat CSS
variables di satu tempat: `etalase/public/css/style.css`, blok `:root` di
baris ~9-49. Ubah nilai variabelnya, otomatis berlaku ke seluruh
`style.css`. Tema alternatif Shopee/TikTokShop
(`[data-theme="shopee"]`, `[data-theme="tiktokshop"]`) TIDAK terpengaruh,
sengaja terpisah.

**Kasire** (POS + admin) — pakai Tailwind, warnanya di
`kasire/tailwind.config.js` → `theme.extend.colors`:
- `ink` — skema netral gelap (pengganti default `slate`/`white` Tailwind),
  nilainya sengaja selaras dengan `--paper`/`--ink`/`--navy-950` milik
  etalase supaya 2 app terasa 1 keluarga.
- `gold` — aksen emas (badge, tombol utama, dsb).
- `blue` — di-remap jadi navy gelap (bukan biru cerah bawaan Tailwind).
- `red`/`green`/`emerald`/`amber`/`orange`/`purple` — cuma shade `50`/`100`
  yang di-override (jadi versi gelap-transparan untuk bg badge/alert),
  shade lain tetap default Tailwind.

Setelah ubah `tailwind.config.js`, WAJIB jalankan `npm run build:css` di
folder `kasire` supaya `public/styles.css` ke-generate ulang (tidak
otomatis kalau cuma edit config-nya saja).

## Cara kerja pemetaan (kasire)

kasire pakai utility class Tailwind langsung di HTML (bukan CSS variable),
jadi tidak bisa 1x ubah token dan otomatis semua berubah seperti etalase.
Solusinya: markup HTML (index.html/admin.html/login.html) sudah di-cari-ganti
massal dari class lama ke class baru, contoh:

| Class lama | Class baru | Alasan |
|---|---|---|
| `bg-white` | `bg-ink-900` | kartu solid terang → permukaan gelap |
| `bg-slate-50` | `bg-ink-950` | input/area redup terang → paling gelap (halaman/input tenggelam) |
| `text-slate-800` | `text-ink-50` | teks utama gelap-di-terang → terang-di-gelap |
| `text-slate-500` | `text-ink-300` | teks sekunder |
| `border-slate-200` | `border-ink-700` | garis tepi tipis |

**PENGECUALIAN PENTING**: `bg-white/10`, `bg-white/20`, dst. (dengan
modifier opacity `/NN`) SENGAJA TIDAK ikut di-mapping — itu overlay
"kaca buram" transparan di atas header/backdrop yang MEMANG sudah gelap
dari awal (bukan kartu solid), jadi harus tetap putih-transparan supaya
kelihatan. Kalau nambah tombol/badge baru dengan pola serupa
(`bg-white/NN` di atas latar gelap), JANGAN diubah ke `bg-ink-*/NN`.

Kalau nambah elemen baru dengan `bg-white`/`bg-slate-*`/`text-slate-*` solid
(tanpa opacity modifier) di kasire, ikuti tabel pemetaan di atas manual,
atau lebih baik langsung pakai class `ink-*`/`gold-*` dari awal.

## Detail teknis lain

- Font: `Sora` (display/judul), `Plus Jakarta Sans` (isi/body) di kasire;
  `IBM Plex Serif` (display), `IBM Plex Sans` (body), `IBM Plex Mono` (angka)
  di etalase — sudah di-load lewat Google Fonts di masing-masing `<head>`,
  tidak berubah dari sebelumnya.
- Scrollbar & focus ring emas custom ditambahkan di
  `kasire/src-css/input.css` (di luar utility Tailwind).
- `theme-color` meta tag (warna address bar browser di mobile) sudah
  disesuaikan ke `#05091c` di kedua aplikasi.
- Signature visual etalase: glow emas ganda di header toko (`.store-header`,
  `style.css` baris ~103-119) — efek "2 lampu sorot butik" dari 2 sudut
  berbeda, dikombinasikan dengan tekstur garis perforasi nota yang sudah
  ada sebelumnya, sebagai satu elemen dekoratif (bukan ditumpuk berlebihan
  di banyak tempat lain — sengaja restraint, 1 titik fokus per halaman).

## Yang BELUM saya kerjakan / batasan jujur

- Saya tidak bisa render/screenshot browser dari sandbox ini, jadi seluruh
  perubahan divalidasi lewat pembacaan kode + build tool (Tailwind CLI
  berhasil compile, brace-balance CSS OK, class ter-generate benar) —
  BUKAN lewat pengecekan visual langsung. Sangat disarankan Anda buka
  langsung di browser (`wrangler dev` / setelah deploy) dan scroll semua
  halaman utama sebelum go-live, terutama layar yang jarang dibuka
  (laporan, modal retur, dsb.) yang tidak sempat saya spot-check manual.
- Ada 1 kelas bug yang saya temukan & perbaiki sendiri saat verifikasi:
  overlay `bg-white/NN` di tombol ikon header sempat ikut ke-mapping jadi
  gelap-di-atas-gelap (nyaris tak kelihatan) sebelum saya temukan dan
  revert manual. Kalau masih ada tombol/ikon yang terasa "hilang" atau
  kontrasnya rendah setelah deploy, kemungkinan besar ini pola yang sama
  di tempat yang belum sempat saya spot-check — beri tahu saya lokasinya,
  gampang diperbaiki.
- Alternatif tema Shopee/TikTokShop di etalase TIDAK diubah (tetap terang/
  sesuai identitas platform masing-masing) — hanya tema *default* yang
  dibuat premium dark+gold, sesuai permintaan Anda.
