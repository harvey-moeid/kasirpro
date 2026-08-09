# muidsoft — Brand Asset Package

## Isi paket

### /svg — file sumber (vector, edit bebas)
- `muidsoft-logo-primary.svg` — logo utama horizontal (icon + wordmark + tagline), untuk header website, dokumen, email signature
- `muidsoft-logo-primary-darkbg.svg` — versi untuk background gelap
- `muidsoft-logo-stacked.svg` — versi vertikal, untuk profil sosial media / avatar
- `muidsoft-appicon.svg` — badge rounded square gradient, sumber utama untuk semua icon aplikasi
- `muidsoft-icon-mark.svg` — mark "M" saja (gradient), untuk watermark
- `muidsoft-icon-mark-white.svg` — mark putih polos, untuk ditaruh di atas foto/background gelap
- `muidsoft-icon-mark-black.svg` — mark hitam polos, untuk print/stempel/dokumen 1 warna

### /favicon — untuk website
- `favicon.ico` (16/32/48px, multi-size) → taruh di root domain
- `favicon-16x16.png`, `favicon-32x32.png`, dst
- `favicon.svg` → favicon modern (scalable, browser terbaru)
- `apple-touch-icon-180x180.png` → untuk saat website di-"Add to Home Screen" di iPhone

Cara pasang di HTML `<head>`:
```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png">
```

### /android — untuk aplikasi Android
- `ic_launcher-mdpi-48x48.png` s/d `ic_launcher-xxxhdpi-192x192.png` → taruh masing-masing di folder `res/mipmap-<density>/` sesuai nama
- `playstore-icon-512x512.png` → khusus untuk upload listing di Google Play Console

### /ios — untuk aplikasi iOS
- Semua ukuran standar Apple (20px s/d 1024px) sudah disediakan untuk diisi ke `AppIcon.appiconset` di Xcode
- `AppIcon-1024x1024.png` → wajib untuk submit ke App Store Connect

### /web — PNG siap pakai untuk keperluan umum (presentasi, dokumen, media sosial)

## Warna resmi
| Warna | Hex | Kegunaan |
|---|---|---|
| Navy gelap | `#050D1C` | dasar gradient, teks utama |
| Navy terang | `#2C5A9E` | ujung gradient, aksen |
| Emas | `#C9A24B` | garis aksen, kesan premium — pakai secukupnya, jangan dominan |
| Abu teks | `#5B6B82` | tagline / teks sekunder |

## Aturan pemakaian singkat
- Jangan ubah proporsi cutout panah di tengah huruf "M" — itu elemen psikologi utama logo (negative space)
- Minimal clear space di sekeliling logo: setinggi huruf "M" itu sendiri
- Di background gelap, selalu pakai versi `-white` atau `-darkbg`, jangan versi gradient biasa (kontras kurang)
- Ukuran minimum: mark tunggal 24px, logo dengan wordmark 120px lebar
