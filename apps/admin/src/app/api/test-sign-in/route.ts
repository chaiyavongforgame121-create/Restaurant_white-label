// TEMPORARY TEST-ONLY route.
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Dev/test only: hard-404 in production unless explicitly enabled.
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_TEST_AUTH !== '1') {
    return new NextResponse(null, { status: 404 });
  }
  const { searchParams } = new URL(req.url);
  const email = searchParams.get('email');
  const password = searchParams.get('password');
  if (!email || !password) return NextResponse.json({ error: 'email_password_required' }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const cookieStore = await cookies();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(toSet: { name: string; value: string; options: CookieOptions }[]) { for (const { name, value, options } of toSet) cookieStore.set(name, value, options); },
    },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, user_email: data.user?.email, app_metadata: data.user?.app_metadata });
}
