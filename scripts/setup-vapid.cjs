// One command to turn on push notifications to locked phones (FavorGO offers, diner order updates).
// Run from the repo root: node scripts/setup-vapid.cjs
//
// Generates a VAPID keypair and stores both keys straight into the Supabase Edge Function secrets
// (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY) through the Supabase CLI. The private key is never printed
// and never written anywhere but a temporary env file that is deleted as soon as the CLI returns.
// The public key (it is public: browsers receive it) is printed and saved to .vapid-public-key, for
// the Vercel env NEXT_PUBLIC_VAPID_PUBLIC_KEY on the driver and web projects.
//
// Refuses to replace keys that are already set: a new keypair silently breaks every existing push
// subscription. Pass --force to rotate anyway (every rider and diner then has to turn
// notifications on again).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_REF = 'ayyfczidnzxetndiijmv';
const force = process.argv.includes('--force');
const root = path.resolve(__dirname, '..');

function supabase(args) {
  const r = spawnSync('npx', ['--yes', 'supabase', ...args, '--project-ref', PROJECT_REF], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const listed = supabase(['secrets', 'list']);
if (!listed.ok) {
  console.error('Could not read the Supabase secrets. Is the Supabase CLI logged in (npx supabase login)?');
  console.error(listed.out.trim());
  process.exit(1);
}
if (/\bVAPID_PRIVATE_KEY\b/.test(listed.out) && !force) {
  console.log('VAPID keys are already set in Supabase. Nothing changed.');
  console.log('(Run with --force to replace them; every phone then has to turn notifications on again.)');
  process.exit(0);
}

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const toUrlBase64 = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const publicKey = toUrlBase64(ecdh.getPublicKey());

const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vapid-')), 'vapid.env');
let set;
try {
  fs.writeFileSync(
    envFile,
    `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${toUrlBase64(ecdh.getPrivateKey())}\n`,
    { mode: 0o600 },
  );
  set = supabase(['secrets', 'set', '--env-file', envFile]);
} finally {
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
}
if (!set.ok) {
  console.error('Setting the Supabase secrets failed; nothing was saved.');
  console.error(set.out.trim());
  process.exit(1);
}

fs.writeFileSync(path.join(root, '.vapid-public-key'), `${publicKey}\n`);
console.log('Done: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set in Supabase.');
console.log('Public key (for Vercel NEXT_PUBLIC_VAPID_PUBLIC_KEY, saved to .vapid-public-key):');
console.log(publicKey);
