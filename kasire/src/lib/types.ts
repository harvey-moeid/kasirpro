// ==========================================================
// types.ts — Shared types & constants
// ==========================================================

// ---- Env & session ----------------------------------------

export type Role = 'super_admin' | 'admin_toko' | 'kasir';

export type AppEnv = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    JWT_SECRET: string;
    ALLOWED_ORIGIN: string;
    ENFORCE_GEO?: string;
    ASSETS: Fetcher;
  };
  Variables: {
    session: SessionPayload;
  };
};

export interface SessionPayload {
  uid: number;
  role: Role;
  toko_pusat_id: number;
  toko_id: number | null;
  exp: number;
}

// ---- Pembayaran --------------------------------------------

export const METODE_BAYAR_VALID = ['cash', 'transfer', 'qris', 'debit'] as const;
export type MetodeBayar = (typeof METODE_BAYAR_VALID)[number];

export interface PembayaranInput {
  metode: MetodeBayar;
  jumlah: number;
}

// ---- Batas langganan ---------------------------------------

/** Batas produk aktif gabungan per tenant */
export const PRODUK_MAX_TOTAL = 200;
/** Batas total R2 per tenant (500MB) */
export const R2_MAX_BYTES_TOTAL = 500 * 1024 * 1024;
/** Ukuran maksimal 1 file gambar (2MB) */
export const GAMBAR_MAX_BYTES = 2 * 1024 * 1024;

export const PESAN_UPGRADE_PRODUK =
  'Batas maksimal 200 produk (gabungan semua toko) sudah tercapai. Upgrade langganan untuk menambah kuota.';
export const PESAN_UPGRADE_R2 =
  'Batas maksimal 500MB penyimpanan gambar (gabungan semua toko) sudah tercapai. Upgrade langganan untuk menambah kuota.';

/** MIME type yang diterima untuk upload gambar */
export const GAMBAR_MIME_VALID: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// ---- Auth --------------------------------------------------

export const SESSION_COOKIE = 'kasir_session';
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MINUTES = 15;

// ---- Setting keys -----------------------------------------

export const STRUK_SETTING_DEFAULTS: Record<string, string> = {
  struk_footer: 'Terima kasih atas kunjungan Anda',
  struk_catatan: '',
  struk_lebar_kertas: '58',
  struk_tampilkan_alamat: '1',
  struk_footer_ikon: 'tidak',
  struk_qr_data: '',
};

export const DAFTAR_TAB_ADMIN = [
  'dashboard', 'produk', 'kasir', 'toko', 'log', 'riwayat', 'etalase', 'pengaturan',
] as const;
