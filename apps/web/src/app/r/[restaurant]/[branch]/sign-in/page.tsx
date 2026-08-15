import { headers } from 'next/headers';
import { resolveTenant } from '@/lib/tenant';
import { SignInView } from './_components/sign-in-view';
import type { Dial } from './_components/sign-in-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

// Reading a request header opts this page out of static rendering, which it needs
// anyway — the preselected country is per visitor, so a cached HTML shell would hand
// everyone whichever country happened to render first.
export const dynamic = 'force-dynamic';

// Geo comes from the edge, not from us: Vercel sets x-vercel-ip-country on every
// request. Cloudflare's cf-ipcountry is read too so a self-hosted or proxied deploy
// behaves the same. Anything we do not sell into falls through to +1 (US is the
// market); the diner can still switch the selector or paste a full +… number.
function dialForCountry(country: string | null): Dial {
  return country?.toUpperCase() === 'TH' ? '+66' : '+1';
}

export default async function SignInPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const h = await headers();
  const country = h.get('x-vercel-ip-country') ?? h.get('cf-ipcountry');
  return (
    <SignInView
      branchId={tenant.branch.id}
      brandName={tenant.restaurant.name}
      defaultDial={dialForCountry(country)}
    />
  );
}
