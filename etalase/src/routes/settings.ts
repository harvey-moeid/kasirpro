import { Hono } from "hono";
import type { Env, Variables } from "../types";

const settings = new Hono<{ Bindings: Env; Variables: Variables }>();

// Publik: dipakai storefront untuk header/info toko + nomor WA.
// Mengubah pengaturan ini sekarang dilakukan dari panel admin KASIRE
// (endpoint PUT /api/etalase/settings di kasire/src/index.ts) — 1 admin,
// 1 login, sesuai keputusan penggabungan. File ini cuma baca.
//
// store_settings sekarang 1 baris PER CABANG (toko_id) -- deployment
// etalase ini SELALU baca baris toko_id-nya sendiri (env.STORE_TOKO_ID),
// tidak pernah baris cabang lain, meskipun tabelnya dipakai bersama.
//
// Kalau baris store_settings belum ada (toko baru yang belum pernah
// buka tab Etalase di admin), fallback ke nama dari tabel toko supaya
// storefront.js tidak menerima null dan crash di settings.theme dll.
settings.get("/", async (c) => {
  // Cache-Control: no-store ditangani oleh global middleware /api/* di index.ts
  const row = await c.env.DB.prepare(
    `SELECT ss.*, COALESCE(ss.store_name, t.nama, 'Toko Saya') AS store_name
     FROM toko t
     LEFT JOIN store_settings ss ON ss.toko_id = t.id
     WHERE t.id = ?`
  ).bind(c.env.STORE_TOKO_ID).first();

  if (!row) {
    return c.json({ settings: { store_name: "Toko Saya", theme: "default", wa_number: "" } });
  }

  return c.json({ settings: row });
});

export default settings;
