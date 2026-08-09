/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/**/*.html'],
  theme: {
    extend: {
      colors: {
        // "blue" di-remap jadi navy gelap supaya seluruh kelas bg-blue-*/
        // text-blue-*/border-blue-* yang sudah ada di markup & JS otomatis
        // ikut berubah tanpa perlu cari-ganti ratusan kelas satu-satu.
        // Shade 50/100 dibuat transparan (bukan solid pucat) karena dipakai
        // sbg bg badge/alert info di atas latar gelap -- solid pucat akan
        // norak, versi transparan menyatu dengan latar gelap di sekitarnya.
        blue: {
          50: 'rgba(90,111,172,0.14)',
          100: 'rgba(90,111,172,0.22)',
          200: '#b3c1e6',
          300: '#8497ce',
          400: '#5a6fac',
          500: '#374d87',
          600: '#1c2f61',
          700: '#16244d',
          800: '#111b3a',
          900: '#0a1228',
        },
        gold: {
          50: '#fdf8ec',
          100: '#f9edc9',
          200: '#f0dc93',
          300: '#e4c467',
          400: '#d6ac42',
          500: '#c2932e',
          600: '#a17423',
          700: '#7d591c',
        },
        // Tier 50/100 warna semantik lain (dipakai luas sbg bg badge/alert:
        // "berhasil", "gagal", "menipis", dst) di-override jadi versi
        // gelap-transparan -- shade 500+ TETAP dari palet default Tailwind
        // (masih cukup terang/vivid untuk teks/ikon di atas latar gelap,
        // tidak perlu diubah). Tanpa ini, badge/alert akan tampil sbg
        // blok warna PUCAT terang yang norak di tengah UI serba gelap.
        red: { 50: 'rgba(220,38,38,0.14)', 100: 'rgba(220,38,38,0.22)' },
        green: { 50: 'rgba(22,163,74,0.14)', 100: 'rgba(22,163,74,0.22)' },
        emerald: { 50: 'rgba(5,150,105,0.14)', 100: 'rgba(5,150,105,0.22)' },
        amber: { 50: 'rgba(217,119,6,0.14)', 100: 'rgba(217,119,6,0.22)' },
        orange: { 50: 'rgba(234,88,12,0.14)', 100: 'rgba(234,88,12,0.22)' },
        purple: { 50: 'rgba(147,51,234,0.14)', 100: 'rgba(147,51,234,0.22)' },
        // "ink" -- skema netral gelap khusus tema premium (dipakai lewat
        // pemetaan eksplisit bg-slate-*/text-slate-*/border-slate-* -> ink-*,
        // lihat MIGRASI-TEMA.md untuk tabel pemetaan lengkapnya). Nilainya
        // sengaja selaras dengan token --paper/--ink/--navy-950 di etalase
        // (etalase/public/css/style.css) supaya kedua aplikasi terasa 1
        // keluarga visual, bukan 2 tema yang kebetulan sama-sama gelap.
        ink: {
          50: '#f3ecdd',
          100: '#dcd6cf',
          200: '#b8b4bd',
          300: '#9498ab',
          400: '#6f7690',
          500: '#545a75',
          600: '#3c4260',
          700: '#262c49',
          800: '#182047',
          900: '#101c3f',
          950: '#05091c',
        },
      },
      fontFamily: {
        display: ['Sora', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
