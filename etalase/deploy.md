> ⚠️ **CATATAN:** Dokumen ini ditulis untuk arsitektur LAMA (database `toko` terpisah). Sejak database digabung dengan kasir, sebagian info di sini (nama database, tabel `products`/`categories`) sudah usang. Baca `ARSITEKTUR.md` di root folder terlebih dahulu.

# Deploy Guide — Toko (Cloudflare Workers)

Panduan deploy & maintenance untuk project ini. Stack: **Hono + Cloudflare Workers + D1 + R2**, frontend vanilla JS di-serve sebagai static assets. Tidak perlu server/VPS — semuanya jalan di Cloudflare.

---

## 1. Prasyarat

- Node.js 18+ dan npm
- Akun Cloudflare (free tier cukup untuk skala 50–200 produk)
- `wrangler` CLI (sudah jadi devDependency, dipanggil lewat `npx`)

Login sekali di device yang dipakai untuk deploy:
```bash
npx wrangler login
```
Ini buka browser untuk otorisasi. Kalau di Termux tanpa GUI browser, `wrangler login` akan kasih link — buka link itu manual di Chrome HP, lalu kembali ke Termux.

---

## 2. Setup pertama kali (device baru / clone baru)

Kalau project ini di-clone di device baru dan resource Cloudflare (D1 + R2) **sudah ada** (dibuat sebelumnya, ID-nya sudah tertulis di `wrangler.toml`), langsung ke bagian **3. Deploy Rutin**.

Kalau ini benar-benar setup dari nol (belum pernah ada D1/R2):

```bash
npm install

npx wrangler d1 create toko
# copy database_id yang muncul, tempel ke wrangler.toml (field database_id)

npx wrangler r2 bucket create toko

npm run db:migrate:remote   # jalankan migrasi ke D1 production
npm run db:seed-admin:remote  # buat akun admin pertama (username + password)
```

---

## 3. Deploy Rutin (tiap kali ada perubahan kode)

```bash
npm install          # cuma perlu kalau package.json berubah
npx wrangler deploy
```

Selesai — Worker langsung update, tidak ada downtime berarti (Cloudflare deploy atomic).

URL default: `https://toko.<subdomain-kamu>.workers.dev`
Kalau sudah pasang custom domain, cek block `routes` di `wrangler.toml`.

---

## 4. Migrasi Database (kalau ada tabel/kolom baru)

**Kapan perlu:** setiap kali ada file baru di folder `migrations/` (misal nambah tabel atau kolom baru).

```bash
# lokal dulu buat test (opsional)
npm run db:migrate:local

# lalu ke production
npm run db:migrate:remote
```

Ini pakai `wrangler d1 migrations apply`, yang melacak migrasi mana yang sudah pernah jalan (tabel `d1_migrations` di D1). **Aman dijalankan berkali-kali** — file yang sudah pernah dieksekusi otomatis dilewati, cuma file baru yang dijalankan.

**Cara nambah migrasi baru** (kalau nanti ada fitur yang butuh kolom/tabel baru):
```bash
npx wrangler d1 migrations create toko nama_perubahan
```
Ini bikin file `migrations/000N_nama_perubahan.sql` — isi dengan SQL-nya (`ALTER TABLE ...` untuk tabel lama, `CREATE TABLE ...` untuk tabel baru), lalu jalankan command migrate di atas.

⚠️ **Jangan pernah edit file migrasi yang sudah ada** (yang sudah pernah di-apply) — selalu buat file baru. Mengedit file lama tidak akan terdeteksi ulang oleh sistem tracking, jadi perubahannya tidak akan pernah ke-apply ke database yang sudah lebih dulu jalan migrasi itu.

**Urutan yang benar kalau ada update kode + migrasi baru:**
1. `npm run db:migrate:remote` (migrasi dulu)
2. `npx wrangler deploy` (baru kode)

Supaya kode baru tidak coba akses kolom/tabel yang belum ada.

---

## 5. Push ke GitHub (dari Termux)

Repo: `https://github.com/ppicwkb/toko.git`

```bash
cd ~/toko-main   # atau lokasi project di Termux

git add -A
git commit -m "Deskripsi perubahan"
git push origin main
```

**Kalau baru pertama kali / repo lokal belum konek:**
```bash
git init
git branch -M main
git remote add origin https://github.com/ppicwkb/toko.git
git add -A
git commit -m "Deskripsi perubahan"
git push origin main --force   # --force cuma untuk push pertama / timpa total
```

Saat diminta password, GitHub **tidak terima password akun biasa** — pakai **Personal Access Token (PAT)**:
- GitHub → Settings → Developer settings → Personal access tokens → Generate new (scope `repo`)
- ⚠️ **Jangan pernah paste token ke chat AI atau tempat publik manapun.** Ketik/paste langsung di prompt Termux saat diminta.
- Simpan biar tidak diminta terus:
  ```bash
  git config --global credential.helper store
  ```

### Troubleshooting umum di Termux

| Error | Fix |
|---|---|
| `detected dubious ownership in repository at ...` | `git config --global --add safe.directory /storage/emulated/0/Download/toko-main` (sesuaikan path) |
| `Author identity unknown` / `Please tell me who you are` | `git config --global user.email "kamu@email.com"` lalu `git config --global user.name "Nama Kamu"` |
| `fatal: unable to auto-detect email address` | Sama seperti di atas — set `user.email` dan `user.name` dulu sebelum commit |
| `src refspec main does not match any` | Belum ada commit — jalankan `git add -A && git commit -m "..."` dulu sebelum push |
| Command ke-gabung jadi satu baris aneh (mis. `.gitcat`) | Jangan paste banyak baris sekaligus di Termux — ketik/jalankan satu command per baris |

---

## 6. Cek Setelah Deploy (checklist manual)

- [ ] Storefront kebuka: `/` — produk muncul, search & filter kategori jalan
- [ ] Tambah ke keranjang → bottom sheet muncul → checkout ke WhatsApp jalan
- [ ] Admin login: `/admin/login.html` — bisa login
- [ ] Tab **Keamanan** → ganti password → berhasil, sesi device lain otomatis logout
- [ ] Upload foto produk (JPG/PNG/WEBP/GIF) → berhasil, gambar tampil di storefront
- [ ] Coba login salah 5x berturut-turut → harus muncul pesan "terlalu banyak percobaan" (rate limit jalan)

---

## 7. Rollback

Cloudflare menyimpan history deployment. Kalau versi baru bermasalah:

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

Untuk kode di GitHub, revert commit seperti biasa:
```bash
git revert HEAD
git push origin main
```

---

## 8. Environment & Secrets

Saat ini tidak ada secret yang perlu di-set manual (password admin sudah di-hash di DB, session pakai token random, bukan JWT). Kalau nanti butuh tambah secret (misal API key pihak ketiga):

```bash
npx wrangler secret put NAMA_SECRET
```
Secret tidak pernah ditaruh di `wrangler.toml` — hanya lewat command di atas, tersimpan di Cloudflare.

---

## Referensi Cepat

| Perintah | Fungsi |
|---|---|
| `npx wrangler dev` | Jalankan lokal untuk testing |
| `npx wrangler deploy` | Deploy ke production |
| `npm run db:migrate:remote` | Jalankan migrasi baru (folder migrations/) ke D1 production |
| `npm run db:seed-admin:remote` | Buat akun admin baru |
| `npx wrangler d1 execute toko --remote --command "SELECT * FROM admin_users"` | Query manual ke D1 production |
| `npx wrangler tail` | Lihat live log Worker production |
