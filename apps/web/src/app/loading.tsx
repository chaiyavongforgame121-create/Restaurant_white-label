import { useTranslations } from 'next-intl';

export default function RootLoading() {
  const t = useTranslations('landing');
  return (
    <div className="grid min-h-dynamic-screen place-items-center">
      <div className="flex flex-col items-center gap-3">
        <span className="h-12 w-12 animate-spin rounded-full border-4 border-muted border-t-primary" />
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </div>
    </div>
  );
}
