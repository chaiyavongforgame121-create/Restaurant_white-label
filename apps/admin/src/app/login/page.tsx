import { LoginView } from './_components/login-view';

interface Props {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { next } = await searchParams;
  return <LoginView next={next ?? '/'} />;
}
