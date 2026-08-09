export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  // toko_id di tabel `toko` (milik kasir) yang produknya ditampilkan
  // di web toko ini — lihat wrangler.toml. Semua query produk/kategori
  // di-scope ke toko_id ini.
  STORE_TOKO_ID: string;
}

// Variables kosong sekarang -- adminId/adminUsername dulu diisi middleware
// auth admin, sudah dihapus sejak kelola admin pindah ke kasire (1 login).
export interface Variables {}

// Merepresentasikan baris tabel `produk` (MILIK KASIR, dipakai bersama).
// Field harga_beli & stok tetap ada di baris DB tapi sengaja tidak
// diekspos ke endpoint publik (lihat routes/products.ts) — hanya field
// yang relevan untuk pembeli/etalase yang dikirim ke client publik.
export interface Product {
  id: number;
  toko_id: number;
  kategori_id: number | null;
  kode_produk: string;
  nama: string;
  harga_jual: number;
  harga_coret: number | null;
  stok: number;
  satuan: string;
  gambar_url: string | null;
  deskripsi_toko: string | null;
  slug: string | null;
  tampil_online: number;
  urutan_tampil: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: number;
  nama: string;
  slug: string | null;
  urutan: number;
}

export interface StoreSettings {
  id: number;
  toko_id: number;
  store_name: string;
  logo_key: string | null;
  wa_number: string;
  address: string | null;
  operating_hours: string | null;
  description: string | null;
  checkout_message_template: string;
}
