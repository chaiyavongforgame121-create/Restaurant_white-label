import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { ChefHat, Home, Search } from 'lucide-react';
import { Button } from '@favornoms/ui';

export async function generateMetadata() {
  const t = await getTranslations('landing');
  return { title: t('notFound.metaTitle') };
}

export default function NotFound() {
  const t = useTranslations('landing.notFound');
  return (
    <main className="grid min-h-dynamic-screen place-items-center bg-gradient-sunset px-6">
      <div className="text-center">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-white/15 text-white backdrop-blur">
          <ChefHat className="h-10 w-10" />
        </div>
        <p className="mt-6 font-display text-7xl font-bold text-gradient">404</p>
        <h1 className="mt-2 font-display text-2xl font-semibold">{t('title')}</h1>
        <p className="mt-2 max-w-sm text-muted-foreground">
          {t('body')}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/">
            <Button variant="gradient" size="lg" leftIcon={<Home className="h-4 w-4" />}>
              {t('backHome')}
            </Button>
          </Link>
          <Link href="/r/coastal-grill/brooklyn">
            <Button variant="outline" size="lg" leftIcon={<Search className="h-4 w-4" />}>
              {t('seeDemo')}
            </Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
