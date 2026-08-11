import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './lib/types';

import authRoutes from './routes/auth';
import produkRoutes from './routes/produk';
import { shiftRoutes, transaksiRoutes, laporanRoutes } from './routes/transaksi';
import {
  tokoRoutes,
  kategoriRoutes,
  settingsRoutes,
  etalaseRoutes,
  usersRoutes,
  logRoutes,
  adminToolsRoutes,
} from './routes/admin';

// ==========================================================
// APP
// ==========================================================

const app = new Hono<AppEnv>();

// ==========================================================
// 1. MIDDLEWARE GLOBAL
// ==========================================================

// CORS di paling atas — preflight (OPTIONS) tidak boleh diblokir geo.
app.use('/*', async (c, next) => {
  const corsMiddleware = cors({
    origin: c.env.ALLOWED_ORIGIN ? c.env.ALLOWED_ORIGIN.split(',') : ['http://localhost:8787'],
    credentials: true,
  });
  return corsMiddleware(c, next);
});

// Geo-Restriction — hanya aktif jika ENFORCE_GEO=true.
// `cf` hanya tersedia di Cloudflare edge sungguhan (undefined saat dev lokal).
app.use('/*', async (c, next) => {
  if (c.env.ENFORCE_GEO === 'true') {
    const country = (c.req.raw as any).cf?.country;
    if (country !== undefined && country !== 'ID') {
      return c.json({ success: false, error: 'Akses ditolak (restriksi geografis)' }, 403);
    }
  }
  await next();
});

// ==========================================================
// 2. ROUTE MOUNT
// ==========================================================

// Auth (login, logout, me, change-password, me/tabs)
// Tab kebijakan cabang: GET/PUT /api/auth/tabs-cabang
app.route('/api/auth', authRoutes);

// Produk (CRUD, galeri, upload, serve gambar)
app.route('/api/produk', produkRoutes);
app.route('/api/upload', produkRoutes);   // POST /api/upload/produk & /api/upload/etalase
app.route('/api/gambar', produkRoutes);   // GET  /api/gambar/*

// Transaksi, shift, laporan
app.route('/api/transaksi', transaksiRoutes);
app.route('/api/shift', shiftRoutes);
app.route('/api/laporan', laporanRoutes);

// Admin — setiap domain di-mount terpisah
app.route('/api/toko', tokoRoutes);
app.route('/api/kategori', kategoriRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/etalase', etalaseRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/log-aktivitas', logRoutes);
app.route('/api/admin', adminToolsRoutes);

// ==========================================================
// 3. FALLBACK
// ==========================================================

app.notFound((c) => c.json({ success: false, error: 'Endpoint tidak ditemukan' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ success: false, error: 'Kesalahan server internal' }, 500);
});

// ==========================================================
// 4. FETCH HANDLER — strip prefix /kasir
// ==========================================================
//
// kasire hidup di https://domainanda.com/kasir/* — bukan domain sendiri.
// Worker ini menerima /kasir/... lalu strip prefix sebelum diteruskan ke
// `app` (API) atau env.ASSETS (file statis).
// Akses langsung *.workers.dev (tanpa /kasir) tetap didukung untuk dev.

const BASE_PATH = '/kasir';

function stripKasirPrefix(url: URL): URL {
  const out = new URL(url.toString());
  if (out.pathname === BASE_PATH || out.pathname === BASE_PATH + '/') {
    out.pathname = '/';
  } else if (out.pathname.startsWith(BASE_PATH + '/')) {
    out.pathname = out.pathname.slice(BASE_PATH.length) || '/';
  }
  return out;
}

export default {
  async fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isMountedAtKasir = url.pathname === BASE_PATH || url.pathname.startsWith(BASE_PATH + '/');

    // /kasir atau /kasir/ → redirect ke login
    if (isMountedAtKasir && (url.pathname === BASE_PATH || url.pathname === BASE_PATH + '/')) {
      return Response.redirect(`${url.origin}${BASE_PATH}/login.html`, 302);
    }
    if (!isMountedAtKasir && url.pathname === '/') {
      return Response.redirect(`${url.origin}/login.html`, 302);
    }

    const cleanUrl = isMountedAtKasir ? stripKasirPrefix(url) : url;

    // Inject X-Kasir-Base agar login/logout set cookie path yang benar.
    const headers = new Headers(request.headers);
    if (isMountedAtKasir) headers.set('X-Kasir-Base', BASE_PATH);

    const cleanRequest = new Request(cleanUrl.toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });

    // /api/* → Hono app | yang lain → file statis dari ASSETS
    if (cleanUrl.pathname.startsWith('/api/')) {
      return app.fetch(cleanRequest, env, ctx);
    }
    return env.ASSETS.fetch(cleanRequest);
  },
};
