import { Hono } from "hono";
import type { Env, Variables } from "../types";

const categories = new Hono<{ Bindings: Env; Variables: Variables }>();

// Publik: daftar kategori untuk filter di storefront. Kelola kategori
// (tambah/ubah/hapus) sekarang lewat panel admin KASIRE (endpoint
// /api/kategori di kasire/src/index.ts) — 1 admin, 1 login.
//
// Kategori sekarang di-scope per TENANT (toko_pusat_id), bukan lagi global
// lintas semua toko di database (lihat ARSITEKTUR.md §8, fitur multi-tenant).
// Worker ini cuma tau toko_id sendiri (STORE_TOKO_ID), jadi toko_pusat_id
// diturunkan lewat JOIN ke tabel `toko` -- TANPA JOIN ini, query bisa balik
// kategori milik SEMUA tenant lain yang berbagi database yang sama.
categories.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT k.id, k.nama as name, k.slug, k.urutan as sort_order
     FROM kategori k
     JOIN toko t ON t.toko_pusat_id = k.toko_pusat_id
     WHERE t.id = ?
     ORDER BY k.urutan ASC, k.nama ASC`
  )
    .bind(c.env.STORE_TOKO_ID)
    .all();
  return c.json({ categories: results });
});

export default categories;
