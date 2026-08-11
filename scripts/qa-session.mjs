#!/usr/bin/env node
// QA helper: mint a Supabase session for a test account, then fetch SSR pages
// or call PostgREST RPCs as that user. Matches @supabase/ssr cookie encoding
// (base64url + "base64-" prefix, chunked at 3180 chars).
//
// Usage:
//   node scripts/qa-session.mjs token <email>
//   node scripts/qa-session.mjs fetch <email|anon> <url> [--raw]
//   node scripts/qa-session.mjs rpc <email|anon> <rpc_name> '<json_args>'
//   node scripts/qa-session.mjs rest <email|anon> <GET|POST|PATCH|DELETE> <path> ['<json_body>']
//
// Password for all test accounts: playtest1234

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = readFileSync(join(root, 'apps/web/.env.local'), 'utf8');
const SUPABASE_URL = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const ANON_KEY = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const PROJECT_REF = SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
const PASSWORD = 'playtest1234';

async function mintSession(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`auth failed for ${email}: ${JSON.stringify(json)}`);
  return json;
}

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sessionCookies(session) {
  const value = 'base64-' + b64url(JSON.stringify(session));
  const name = `sb-${PROJECT_REF}-auth-token`;
  const MAX = 3180;
  if (value.length <= MAX) return [[name, value]];
  const chunks = [];
  for (let i = 0; i * MAX < value.length; i++) chunks.push([`${name}.${i}`, value.slice(i * MAX, (i + 1) * MAX)]);
  return chunks;
}

async function cookieHeaderFor(email) {
  if (email === 'anon') return '';
  const session = await mintSession(email);
  return sessionCookies(session).map(([k, v]) => `${k}=${v}`).join('; ');
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const [, , cmd, who, ...rest] = process.argv;

if (cmd === 'token') {
  const s = await mintSession(who);
  console.log(JSON.stringify({ access_token: s.access_token, user_id: s.user.id, email: s.user.email, app_metadata: s.user.app_metadata }, null, 2));
} else if (cmd === 'fetch') {
  const [url, flag] = rest;
  const cookie = await cookieHeaderFor(who);
  const res = await fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const body = await res.text();
  console.log(`STATUS ${res.status}${res.headers.get('location') ? ' -> ' + res.headers.get('location') : ''}`);
  console.log(flag === '--raw' ? body : stripHtml(body).slice(0, 4000));
} else if (cmd === 'rpc') {
  const [name, args] = rest;
  const headers = { 'Content-Type': 'application/json', apikey: ANON_KEY };
  if (who !== 'anon') headers.Authorization = `Bearer ${(await mintSession(who)).access_token}`;
  else headers.Authorization = `Bearer ${ANON_KEY}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: args || '{}' });
  console.log(`STATUS ${res.status}`);
  console.log(await res.text());
} else if (cmd === 'rest') {
  const [method, path, body] = rest;
  const headers = { 'Content-Type': 'application/json', apikey: ANON_KEY, Prefer: 'return=representation' };
  if (who !== 'anon') headers.Authorization = `Bearer ${(await mintSession(who)).access_token}`;
  else headers.Authorization = `Bearer ${ANON_KEY}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { method, headers, body });
  console.log(`STATUS ${res.status}`);
  console.log((await res.text()).slice(0, 4000));
} else {
  console.log('usage: qa-session.mjs token|fetch|rpc|rest ...');
  process.exit(1);
}
