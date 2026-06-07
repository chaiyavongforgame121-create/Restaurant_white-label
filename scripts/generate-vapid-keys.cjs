// One-shot helper to generate a VAPID keypair for Web Push.
// Run: node scripts/generate-vapid-keys.cjs
// Paste the printed values into Supabase Dashboard → Project Settings →
// Edge Functions → Secrets (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY) and into
// apps/{web,driver}/.env.local (NEXT_PUBLIC_VAPID_PUBLIC_KEY).

const crypto = require('crypto');

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const publicKey = ecdh.getPublicKey();
const privateKey = ecdh.getPrivateKey();

const toUrlBase64 = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

console.log('# VAPID keys for Web Push — generated', new Date().toISOString());
console.log('# Paste into Supabase Edge Function Secrets:');
console.log('VAPID_PUBLIC_KEY=' + toUrlBase64(publicKey));
console.log('VAPID_PRIVATE_KEY=' + toUrlBase64(privateKey));
console.log('');
console.log('# Also paste the public key into apps/{web,driver}/.env.local:');
console.log('NEXT_PUBLIC_VAPID_PUBLIC_KEY=' + toUrlBase64(publicKey));
