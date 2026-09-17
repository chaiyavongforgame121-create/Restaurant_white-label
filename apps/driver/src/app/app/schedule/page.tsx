'use client';

import { useTranslations } from 'next-intl';
import { ScheduleEditor } from '@/components/schedule-editor';

export default function SchedulePage() {
  const t = useTranslations('home');
  return (
    <div className="container max-w-xl py-6">
      <header className="mb-5 px-1">
        <h1 className="font-display text-2xl font-bold">{t('schedule.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('schedule.intro')}</p>
      </header>
      <ScheduleEditor />
    </div>
  );
}
