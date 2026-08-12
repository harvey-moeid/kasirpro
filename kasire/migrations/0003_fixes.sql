-- ==========================================================
-- Migration 0003 — Bug Fixes
--
-- Perbaikan:
-- 1. Slug produk: index UNIQUE global → UNIQUE per toko_id
--    Bug lama: 'kopi-susu' di Tenant A bentrok dengan Tenant B.
--    Fix: DROP index lama, CREATE UNIQUE INDEX (toko_id, slug).
--
-- 2. Tidak ada perubahan DDL lain — semua fix lain (log query,
--    reset-data, laporan laba) ada di kode TypeScript, bukan skema.
--
-- Jalankan lewat:
--   npx wrangler d1 migrations apply kasirpro --remote
-- ==========================================================

-- Step 1: Hapus index slug global yang salah
DROP INDEX IF EXISTS idx_produk_slug;

-- Step 2: Buat index slug baru yang benar — UNIQUE per toko_id
-- Efek: slug 'kopi-susu' bisa ada di Toko A dan Toko B (beda toko),
-- tapi tidak bisa duplikat dalam SATU toko yang sama.
-- Ini sudah benar karena storefront etalase per-deployment = per toko_id.
CREATE UNIQUE INDEX idx_produk_slug_per_toko ON produk(toko_id, slug) WHERE slug IS NOT NULL;
