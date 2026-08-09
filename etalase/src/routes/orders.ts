import { Hono } from "hono";
import type { Env, Variables } from "../types";

const orders = new Hono<{ Bindings: Env; Variables: Variables }>();

interface OrderItemInput {
  id?: number;
  name?: string;
  price?: number;
  qty?: number;
}

const MAX_ITEMS = 100;
const MAX_NAME_LEN = 120;
const MAX_NOTE_LEN = 500;

// Publik: dipanggil storefront tepat sebelum membuka link WhatsApp checkout.
// Ini cuma LOG (bukan transaksi/pengurang stok — pengurangan stok TETAP
// hanya terjadi lewat kasir saat pesanan ini benar-benar diproses jadi
// penjualan di kasir) — supaya admin bisa lihat riwayat tanpa scroll-scroll
// chat WA. Harga di-snapshot dari yang dikirim client saat itu.
orders.post("/", async (c) => {
  const body = await c.req
    .json<{ buyer_name?: string; buyer_note?: string; items?: OrderItemInput[]; total?: number }>()
    .catch(() => null);

  const buyerName = body?.buyer_name?.trim().slice(0, MAX_NAME_LEN);
  const items = Array.isArray(body?.items) ? body!.items : [];

  if (!buyerName || items.length === 0) {
    return c.json({ error: "Nama pembeli dan item wajib diisi" }, 400);
  }
  if (items.length > MAX_ITEMS) {
    return c.json({ error: "Terlalu banyak item" }, 400);
  }

  const cleanItems = items.slice(0, MAX_ITEMS).map((i) => ({
    id: Number.isFinite(i.id) ? Number(i.id) : null,
    name: String(i.name ?? "Produk").slice(0, MAX_NAME_LEN),
    price: Number.isFinite(i.price) ? Math.max(0, Math.round(Number(i.price))) : 0,
    qty: Number.isFinite(i.qty) ? Math.max(1, Math.round(Number(i.qty))) : 1,
  }));

  const total = cleanItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  const buyerNote = body?.buyer_note?.trim().slice(0, MAX_NOTE_LEN) || null;

  const itemsForStorage = cleanItems.map(({ id, ...rest }) => rest);
  const result = await c.env.DB.prepare(
    `INSERT INTO orders (toko_id, buyer_name, buyer_note, items_json, total) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(c.env.STORE_TOKO_ID, buyerName, buyerNote, JSON.stringify(itemsForStorage), total)
    .run();

  // Catat produk_id per item supaya bisa hitung "X terjual" nyata per produk.
  // FIX (integritas data): produk_id dari client WAJIB divalidasi milik
  // STORE_TOKO_ID dulu sebelum di-insert — tanpa ini, client bisa mengirim
  // produk_id dari toko/tenant lain dan menaikkan sold_count toko tersebut
  // secara palsu (tampil di storefront sebagai "X terjual"). Query 1 kali
  // untuk semua id sekaligus (IN clause), lalu whitelist yang valid saja.
  const orderId = result.meta.last_row_id;
  const withProductId = cleanItems.filter((i) => i.id);
  if (withProductId.length > 0) {
    const ids = withProductId.map((i) => i.id);
    const placeholders = ids.map(() => "?").join(",");
    const { results: validProduk } = await c.env.DB.prepare(
      `SELECT id FROM produk WHERE id IN (${placeholders}) AND toko_id = ? AND is_active = 1`
    )
      .bind(...ids, c.env.STORE_TOKO_ID)
      .all<{ id: number }>();
    const validIds = new Set(validProduk.map((r) => r.id));

    const validItems = withProductId.filter((i) => validIds.has(i.id!));
    if (validItems.length > 0) {
      const stmts = validItems.map((i) =>
        c.env.DB.prepare(`INSERT INTO order_items (order_id, produk_id, qty) VALUES (?, ?, ?)`).bind(
          orderId,
          i.id,
          i.qty
        )
      );
      await c.env.DB.batch(stmts);
    }
  }

  return c.json({ ok: true });
});

// Melihat riwayat pesanan (admin) sekarang lewat panel KASIRE, endpoint
// GET /api/etalase/orders di kasire/src/index.ts — 1 admin, 1 login.

export default orders;
