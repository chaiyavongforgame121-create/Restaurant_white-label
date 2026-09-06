import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
// node:fs below; also what a route reading the deployment env should be running on anyway.
export const runtime = 'nodejs';

/**
 * Which build is live right now.
 *
 * An installed PWA is not a browser tab: a phone keeps it in memory for days, and nothing in
 * the platform tells the running page that a deploy has happened. The client polls this and
 * offers a reload when the answer changes (see components/service-worker.tsx). The service
 * worker never touches /api/, so this is always the network's answer and never a cached one.
 *
 * Resolved lazily and once: on Vercel the deployment id is exact and free; a self-hosted
 * `next start` has .next/BUILD_ID, which changes on every build. Falling through to a constant
 * only means no banner is ever shown — never a false one.
 */
let cachedBuildId: string | null = null;

function buildId(): string {
  if (cachedBuildId !== null) return cachedBuildId;
  const fromEnv =
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.NEXT_PUBLIC_BUILD_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12);
  if (fromEnv) {
    cachedBuildId = fromEnv;
    return cachedBuildId;
  }
  try {
    cachedBuildId = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || 'dev';
  } catch {
    cachedBuildId = 'dev';
  }
  return cachedBuildId;
}

export function GET() {
  return NextResponse.json({ build: buildId() }, { headers: { 'Cache-Control': 'no-store' } });
}
