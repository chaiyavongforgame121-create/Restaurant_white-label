import { UpdatePasswordView } from './_components/update-password-view';

export const metadata = { title: 'Choose a password' };

interface Props {
  searchParams: Promise<{ welcome?: string }>;
}

export default async function UpdatePasswordPage({ searchParams }: Props) {
  const { welcome } = await searchParams;
  return <UpdatePasswordView welcome={welcome === '1'} />;
}
