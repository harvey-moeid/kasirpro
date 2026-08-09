# Deploy Guide — kasirpro

Panduan deploy dari nol. Stack: **Hono + Cloudflare Workers + D1 + R2**.  
Repo ini berisi 2 Worker terpisah yang share 1 database dan 1 bucket:

| Folder | Worker | URL default | Fungsi |
|---|---|---|---|
| `kasire/` | `kasirpro` | `kasirpro.*.workers.dev` | Kasir + panel admin |
| `etalase/` | `etalasepro` | `etalasepro.*.workers.dev` | Storefront publik |

---

## Prasyarat

- Node.js 18+ (`node -v`)
- Akun Cloudflare (free tier cukup)
- Wrangler sudah jadi `devDependency` di masing-masing folder — dipanggil lewat `npx`, tidak perlu install global

---

## 1. Login ke Cloudflare

```bash
npx wrangler login
```

Browser terbuka → klik **Allow**. Verifikasi:

```bash
npx wrangler whoami
```

> **Termux (tanpa GUI browser):** `wrangler login` akan cetak URL — buka manual di Chrome HP, lalu kembali ke Termux.

---

## 2. Buat Resource Cloudflare (sekali saja, dari folder `kasire/`)

> Lewati bagian ini kalau D1 dan R2 sudah ada. Lanjut ke bagian 3.

```bash
cd kasire

# Buat D1 database
npx wrangler d1 create kasirpro
```

Output:
```
✅ Successfully created DB 'kasirpro'

[[d1_databases]]
binding = "DB"
database_name = "kasirpro"
database_id = "xxxx-xxxx-xxxx-xxxx"
```

**Salin `database_id`** ke dua file sekaligus:
- `kasire/wrangler.toml` → field `database_id` di `[[d1_databases]]`
- `etalase/wrangler.toml` → field `database_id` di `[[d1_databases]]`

Keduanya **harus nilai yang sama persis** — 1 database fisik dipakai bersama.

```bash
# Buat R2 bucket
npx wrangler r2 bucket create kasirpro
```

---

## 3. Set JWT_SECRET

JWT_SECRET **tidak boleh** ada di `wrangler.toml` (file itu ikut ke git). Set lewat Wrangler secret — hanya untuk `kasire`, etalase tidak butuh.

```bash
cd kasire

# Generate secret acak dulu
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Lalu set ke Cloudflare
npx wrangler secret put JWT_SECRET
# paste hasil generate di atas saat diminta
```

Untuk **dev lokal**:
```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars, isi JWT_SECRET dengan string acak
# file ini sudah ada di .gitignore, tidak akan ter-commit
```

---

## 4. Migrasi Database (sekali saja, dari folder `kasire/`)

```bash
cd kasire
npm run db:migrate:remote
```

Ini menjalankan `migrations/0001_init.sql` yang berisi skema lengkap + seed data awal:

| Username | Password  | Role        |
|----------|-----------|-------------|
| `admin`  | `admin123` | super_admin |
| `kasir1` | `kasir123` | kasir       |

> ⚠️ **Ganti password default** sebelum go-live (lihat bagian 9).

Migrasi hanya perlu dijalankan **sekali**. Cloudflare mencatat file mana yang sudah dieksekusi — kalau dijalankan ulang, file yang sama dilewati otomatis.

---

## 5. Deploy Manual (dari lokal)

### kasire

```bash
cd kasire
npm install
npm run deploy
# = build CSS + migrate D1 remote + wrangler deploy
```

### etalase

```bash
cd etalase
npm install
npm run deploy
# = wrangler deploy
```

URL akan muncul di output:
```
https://kasirpro.harveymoeid.workers.dev   ← kasire
https://etalasepro.harveymoeid.workers.dev  ← etalase
```

---

## 6. CI/CD via Cloudflare Dashboard (otomatis saat push ke GitHub)

Masuk ke **Cloudflare Dashboard → Workers & Pages**, setup 2 project terpisah.

### Project: kasirpro

| Setting | Nilai |
|---|---|
| Root directory | `kasire` |
| Build command | `npm install` |
| Deploy command | `npx wrangler d1 migrations apply kasirpro --remote && npx wrangler deploy` |

### Project: etalasepro

| Setting | Nilai |
|---|---|
| Root directory | `etalase` |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |

Setelah ini setiap `git push` ke branch utama → kedua Worker auto-deploy. Migrasi D1 jalan otomatis sebelum kasire di-deploy.

---

## 7. Pasang Domain Sendiri (opsional)

Domain **harus jadi zone aktif di Cloudflare** (DNS dikelola Cloudflare) — bukan sekadar custom domain biasa, karena path-based routing butuh Cloudflare Routes.

### Update `wrangler.toml` di kedua folder

**`kasire/wrangler.toml`** — ganti `domainanda.com` dengan domain asli:
```toml
routes = [
  { pattern = "domainanda.com/kasir", zone_name = "domainanda.com" },
  { pattern = "domainanda.com/kasir/*", zone_name = "domainanda.com" }
]
```

**`etalase/wrangler.toml`** — ganti `domainanda.com` dengan domain yang sama:
```toml
routes = [
  { pattern = "domainanda.com/*", zone_name = "domainanda.com" }
]
```

Deploy ulang keduanya setelah perubahan ini.

### Cara kerja routing

Cloudflare otomatis pilih pattern paling spesifik:

```
domainanda.com/kasir     → Worker kasirpro
domainanda.com/kasir/*   → Worker kasirpro
domainanda.com/*         → Worker etalasepro
```

`/kasir/*` selalu menang lawan `/*` — tidak saling tabrakan.

---

## 8. Dev Lokal

```bash
# kasire
cd kasire
npm run db:migrate:local   # buat D1 lokal dulu (sekali saja)
npm run dev                # buka http://localhost:8787/kasir/login.html

# etalase (terminal terpisah)
cd etalase
npm run dev                # buka http://localhost:8787
```

---

## 9. Ganti Password Default

Generate hash baru:

```bash
cd kasire
node scripts/gen-password-hash.mjs "PASSWORD_BARU"
# output: password_hash dan password_salt
```

Update ke database:

```bash
npx wrangler d1 execute kasirpro --remote --command \
  "UPDATE users SET password_hash='HASH', password_salt='SALT' WHERE username='admin';"
```

---

## 10. Perintah Operasional

| Kebutuhan | Command |
|---|---|
| Log real-time kasire | `cd kasire && npx wrangler tail` |
| Log real-time etalase | `cd etalase && npx wrangler tail` |
| Query D1 langsung | `npx wrangler d1 execute kasirpro --remote --command "SELECT * FROM produk;"` |
| Cek migration status | `npx wrangler d1 migrations list kasirpro --remote` |
| Jalankan SQL file langsung | `npx wrangler d1 execute kasirpro --remote --file=migrations/0001_init.sql` |
| Cek secret yang sudah diset | `cd kasire && npx wrangler secret list` |
| Ganti JWT_SECRET | `cd kasire && npx wrangler secret put JWT_SECRET` |
| Lihat isi R2 bucket | `npx wrangler r2 object list kasirpro` |

---

## 11. Troubleshooting

**Login selalu gagal (error 500)**  
→ `JWT_SECRET` belum diset. Jalankan `npx wrangler secret put JWT_SECRET` dari folder `kasire/`.

**Halaman kosong / tabel tidak ada**  
→ Migrasi belum jalan. Jalankan `cd kasire && npm run db:migrate:remote`.

**Migrasi sudah "Applied" tapi data kosong**  
→ Jalankan SQL langsung: `npx wrangler d1 execute kasirpro --remote --file=kasire/migrations/0001_init.sql`

**CI deploy tidak migrate D1**  
→ Pastikan deploy command di Cloudflare Dashboard sudah: `npx wrangler d1 migrations apply kasirpro --remote && npx wrangler deploy` (bukan hanya `npx wrangler deploy`).

**Domain tidak terhubung ke Worker**  
→ Domain harus jadi zone aktif di Cloudflare (DNS managed Cloudflare). Custom Domain biasa tidak support path-based routing.

**Produk kasire tidak muncul di etalase**  
→ Cek `STORE_TOKO_ID` di `etalase/wrangler.toml` — harus sama dengan `id` di tabel `toko`. Verifikasi: `npx wrangler d1 execute kasirpro --remote --command "SELECT id, nama FROM toko;"`.
