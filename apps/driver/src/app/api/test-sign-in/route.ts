// TEMPORARY TEST-ONLY route (dev login helper, mirrors apps/admin).
import { NextResponse, type NextRequest } from 'next/server';
import { getServerClient } from '@favornoms/database/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Dev/test only: hard-404 in production unless explicitly enabled.
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_TEST_AUTH !== '1') {
    return new NextResponse(null, { status: 404 });
  }
  const { searchParams } = new URL(req.url);
  const email = searchParams.get('email');
  const password = searchParams.get('password');
  if (!email || !password) {
    return NextResponse.json({ error: 'email_password_required' }, { status: 400 });
  }
  const supabase = await getServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, user_email: data.user?.email, app_metadata: data.user?.app_metadata });
}
