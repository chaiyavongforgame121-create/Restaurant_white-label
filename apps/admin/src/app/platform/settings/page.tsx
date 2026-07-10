import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { PlatformAccessDenied } from '../_components/platform-nav';
import { PlatformSettingsView } from './_components/platform-settings-view';

export default async function PlatformSettingsPage() {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/settings');

  // get_platform_settings self-gates to platform admins — an error means not authorized.
  const { data, error } = await supabase.rpc('get_platform_settings');
  if (error) return <PlatformAccessDenied />;

  return <PlatformSettingsView initial={(data ?? {}) as Record<string, unknown>} />;
}
