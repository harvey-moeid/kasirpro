import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { toPublicProduct } from "../lib/produk";

const products = new Hono<{ Bindings: Env; Variables: Variables }>();

// ==========================================================
// CATATAN PENTING (baca sebelum ubah file ini):
//
// Tabel `produk` di sini adalah tabel yang SAMA PERSIS dipakai kasir
// (1 database dipakai bersama, lihat wrangler.toml). Semua query di
// bawah WAJIB di-scope dengan `toko_id = ?env.STORE_TOKO_ID` supaya
// web toko ini hanya menampilkan produk cabang yang benar.
//
// STOK TIDAK PERNAH ditulis dari sini. Stok hanya berubah lewat kasir
// (transaksi jual / koreksi stok manual) — web toko cuma MEMBACA kolom
// stok, itu sebabnya selalu real-time tanpa proses sync terpisah.
// Status "available"/"sold_out" diturunkan otomatis dari stok > 0.
//
// KELOLA PRODUK (tambah/ubah/hapus/tampil-sembunyi/galeri) sekarang SEMUA
// lewat panel admin KASIRE (endpoint /api/produk & /api/produk/:id/galeri
// di kasire/src/index.ts) — 1 admin, 1 login, sesuai keputusan
// penggabungan. File ini SEKARANG CUMA BACA (publik, tanpa auth).
// ==========================================================

// ---------- Publik: daftar produk untuk storefront ----------
products.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  const categorySlug = c.req.query("category")?.trim();
  const includeSoldOut = c.req.query("include_sold_out") === "1";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10) || 200, 500);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const tokoId = c.env.STORE_TOKO_ID;

  let sql = `
    SELECT p.id, p.nama, p.deskripsi_toko, p.harga_jual, p.harga_coret, p.kategori_id,
           p.gambar_url, p.stok, p.slug, p.kode_produk, p.created_at, p.updated_at,
           k.nama as category_name, k.slug as category_slug,
           (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi WHERE oi.produk_id = p.id) as sold_count
    FROM produk p
    LEFT JOIN kategori k ON k.id = p.kategori_id
    WHERE p.toko_id = ? AND p.is_active = 1 AND p.tampil_online = 1
  `;
  const binds: unknown[] = [tokoId];

  if (!includeSoldOut) {
    sql += ` AND p.stok > 0`;
  }
  if (q) {
    sql += ` AND p.nama LIKE ?`;
    binds.push(`%${q}%`);
  }
  if (categorySlug) {
    sql += ` AND k.slug = ?`;
    binds.push(categorySlug);
  }
  sql += ` ORDER BY p.urutan_tampil ASC, p.created_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ products: results.map(toPublicProduct) });
});

// Publik: detail 1 produk (termasuk galeri foto tambahan)
products.get("/:id", async (c) => {
  const id = c.req.param("id");
  const tokoId = c.env.STORE_TOKO_ID;

  const product = await c.env.DB.prepare(
    `SELECT p.*, k.nama as category_name, k.slug as category_slug,
            (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi WHERE oi.produk_id = p.id) as sold_count
     FROM produk p LEFT JOIN kategori k ON k.id = p.kategori_id
     WHERE p.id = ? AND p.toko_id = ? AND p.tampil_online = 1 AND p.is_active = 1`
  )
    .bind(id, tokoId)
    .first<Record<string, unknown>>();
  if (!product) return c.json({ error: "Produk tidak ditemukan" }, 404);

  const { results: galleryRows } = await c.env.DB.prepare(
    `SELECT image_key FROM produk_galeri WHERE produk_id = ? ORDER BY urutan ASC, id ASC`
  )
    .bind(id)
    .all<{ image_key: string }>();

  return c.json({
    product: { ...toPublicProduct(product), gallery_images: galleryRows.map((r) => r.image_key) },
  });
});

export default products;
