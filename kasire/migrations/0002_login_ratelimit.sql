-- Migration 0002 — Rate Limiting Login
-- Tambah 2 kolom ke tabel users untuk melacak percobaan login gagal:
--   failed_attempts : counter percobaan gagal berurutan (reset ke 0 saat berhasil)
--   locked_until    : timestamp UTC ISO 8601 sampai kapan akun terkunci (NULL = tidak terkunci)
--
-- Logika (di src/index.ts POST /api/auth/login):
--   - Cek locked_until dulu; kalau masih di masa lock → tolak langsung
--   - Login gagal: failed_attempts + 1; kalau >= 5 → set locked_until = now + 15 menit
--   - Login sukses: reset failed_attempts = 0, locked_until = NULL

ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
