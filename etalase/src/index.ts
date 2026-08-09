import { Hono } from "hono";
import type { Env, Variables } from "./types";

import products from "./routes/products";
import categories from "./routes/categories";
import settings from "./routes/settings";
import images from "./routes/images";
import orders from "./routes/orders";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Tidak perlu CORS: frontend (public/) dan API (/api/*) di-serve dari origin
// yang sama lewat Workers Assets. Middleware CORS permisif sebelumnya
// (reflect origin apa pun + credentials: true) dihapus karena hanya
// menambah permukaan serang tanpa manfaat fungsional untuk setup ini.
//
// CATATAN PENGGABUNGAN ADMIN: Worker ini (etalase) sekarang HANYA berisi
// route PUBLIK (baca produk/kategori/settings, kirim checkout WA). Semua
// route admin (login, kelola produk/kategori/pesanan/pengaturan/upload)
// sudah dipindah ke Worker kasire (1 admin, 1 login) — lihat ARSITEKTUR.md.

app.route("/api/products", products);
app.route("/api/categories", categories);
app.route("/api/settings", settings);
app.route("/api/orders", orders);
app.route("/images", images);

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));

// Semua request lain (HTML/CSS/JS statis) ditangani oleh Workers Assets
// lewat konfigurasi [assets] di wrangler.toml — fetch handler ini hanya
// menangani /api/* dan /images/*. Fallback di bawah untuk 404 API.
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Endpoint tidak ditemukan" }, 404);
  }
  return c.text("Not found", 404);
});

// Tanpa ini, error yang tidak ketangkep (mis. constraint DB, bug tak
// terduga) bisa bikin response mentah/kosong ke client alih-alih JSON
// yang rapi. Project toko sebelumnya TIDAK punya ini sama sekali —
// gap lama, ditambahkan sekarang, pola sama dengan kasire/src/index.ts.
app.onError((err, c) => {
  console.error(err);
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Kesalahan server internal" }, 500);
  }
  return c.text("Kesalahan server internal", 500);
});

export default app;
