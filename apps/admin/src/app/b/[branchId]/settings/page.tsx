import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CreditCard, Cog, Languages } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { LocaleSwitcher } from '@/components/locale-switcher';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function SettingsPage({ params }: Props) {
  const { branchId } = await params;
  const t = await getTranslations('settings.index');
  return (
    <div className="container max-w-3xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
      </header>

      <div className="grid grid-cols-1 gap-3 px-2 lg:px-0">
        <Link href={`/b/${branchId}/settings/plan`} className="focus-ring rounded-2xl">
          <Card className="flex items-center justify-between p-5 transition-shadow hover:shadow-warm">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <CreditCard className="h-5 w-5" />
              </span>
              <div>
                <p className="font-display text-base font-semibold">{t('planTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('planDescription')}</p>
              </div>
            </div>
            <span className="text-muted-foreground">→</span>
          </Card>
        </Link>
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Languages className="h-5 w-5" />
            </span>
            <div>
              <p className="font-display text-base font-semibold">{t('languageTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('languageDescription')}</p>
            </div>
          </div>
          <LocaleSwitcher />
        </Card>
        <Card className="flex items-center justify-between p-5 opacity-60">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-muted text-muted-foreground">
              <Cog className="h-5 w-5" />
            </span>
            <div>
              <p className="font-display text-base font-semibold">{t('themeTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('themeDescription')}</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
