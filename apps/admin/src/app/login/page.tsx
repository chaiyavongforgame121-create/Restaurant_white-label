import { LoginView } from './_components/login-view';

interface Props {
  searchParams: Promise<{ next?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { next, error } = await searchParams;
  return <LoginView next={next ?? '/'} error={error ?? null} />;
}
