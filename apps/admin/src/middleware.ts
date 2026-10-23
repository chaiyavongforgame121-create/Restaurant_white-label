import { updateSession } from '@favornoms/database/middleware';
import type { NextRequest } from 'next/server';
export async function middleware(request: NextRequest) {
  return updateSession(request);
}
export const config = {
  // Static files skip the session refresh (a Supabase getUser() round trip for a signed-in user):
  // the splash art (.webp), the icons (.png/.ico) and the install manifest included.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)'],
};
