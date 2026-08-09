// Helper khusus untuk operasi web toko terhadap tabel `produk` (milik
// kasir, dipakai bersama). Lihat juga ARSITEKTUR.md untuk penjelasan skema.
//
// CATATAN PENGGABUNGAN ADMIN: fungsi-fungsi yang dulu ada di sini untuk
// kebutuhan admin (slugify, generateKodeProduk, getProductCount,
// toAdminProduct, dst.) sudah pindah ke kasire/src/index.ts karena
// kelola produk sekarang lewat panel admin kasire (1 admin, 1 login).
// File ini sekarang cuma berisi helper untuk endpoint PUBLIK.

// Bentuk baris `produk` (kolom kasir) menjadi kontrak JSON lama yang
// sudah dipakai frontend PUBLIK storefront (name/price/status/dst) —
// supaya HTML/JS yang sudah ada tidak perlu dibongkar total.
//
// SENGAJA TIDAK menyertakan angka stok mentah (`stok`) — siapapun
// (termasuk kompetitor) bisa scraping persis sisa stok tiap produk lewat
// API publik kalau ini disertakan, padahal itu bukan yang diminta.
export function toPublicProduct(row: Record<string, any>): Record<string, any> {
  return {
    id: row.id,
    name: row.nama,
    description: row.deskripsi_toko,
    price: row.harga_jual,
    original_price: row.harga_coret,
    category_id: row.kategori_id,
    category_name: row.category_name ?? null,
    category_slug: row.category_slug ?? null,
    image_key: row.gambar_url,
    status: Number(row.stok) > 0 ? "available" : "sold_out",
    slug: row.slug,
    kode_produk: row.kode_produk,
    sold_count: row.sold_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
