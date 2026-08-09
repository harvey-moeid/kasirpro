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
settings.get("/", async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM store_settings WHERE toko_id = ?`).bind(c.env.STORE_TOKO_ID).first();
  return c.json({ settings: row });
});

export default settings;
