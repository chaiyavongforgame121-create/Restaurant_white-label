import { ThemeProvider } from '@favornoms/ui';
import { AppShell } from '@/components/app-shell';
import { PushSubscriber } from '@/components/push-subscriber';
import { resolveTenant } from '@/lib/tenant';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
  children: React.ReactNode;
}

export default async function BranchLayout({ params, children }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;

  // Per implementation.md §10.2 — merge restaurant.brand + branch.override
  // ThemeProvider applies as CSS variables on a wrapping div.
  return (
    <ThemeProvider theme={tenant.theme}>
      <AppShell base={base} brandName={tenant.theme.brandName ?? tenant.restaurant.name}>
        <PushSubscriber />
        {children}
      </AppShell>
    </ThemeProvider>
  );
}

export async function generateMetadata({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  return {
    title: tenant.restaurant.name,
    description: `Order from ${tenant.restaurant.name} — ${tenant.branch.name}`,
  };
}
