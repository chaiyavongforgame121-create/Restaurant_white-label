import { resolveTenant } from '@/lib/tenant';
import { SignInView } from './_components/sign-in-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function SignInPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  return <SignInView branchId={tenant.branch.id} brandName={tenant.restaurant.name} />;
}
