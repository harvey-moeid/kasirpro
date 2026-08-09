// Generate PBKDF2-SHA256 hash + salt untuk kolom users.password_hash / password_salt
// Algoritma HARUS identik dengan src/lib/crypto.ts (100.000 iterasi, SHA-256, 256 bit).
//
// Pemakaian:
//   node scripts/gen-password-hash.mjs "passwordBaru123"
//
// Lalu copy hasil hash & salt ke migrations/0001_init.sql (seed) atau ke
// perintah UPDATE manual lewat wrangler d1 execute.

const PBKDF2_ITERATIONS = 100_000;

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

async function derivePBKDF2(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(derivedBits);
}

const password = process.argv[2];
if (!password) {
  console.error('Pemakaian: node scripts/gen-password-hash.mjs "passwordAnda"');
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const hash = await derivePBKDF2(password, salt);

console.log('password_hash :', hash);
console.log('password_salt :', toBase64(salt));
