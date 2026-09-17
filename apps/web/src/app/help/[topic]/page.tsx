import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft } from 'lucide-react';
import { TOPICS } from '../_topics';

const SUPPORT_EMAIL = 'support@favornoms.com';

interface Props {
  params: Promise<{ topic: string }>;
}

export function generateStaticParams() {
  return TOPICS.map((t) => ({ topic: t.slug }));
}

export async function generateMetadata({ params }: Props) {
  const { topic } = await params;
  const found = TOPICS.find((x) => x.slug === topic);
  const t = await getTranslations('help');
  return {
    title: found
      ? t('meta.topicTitle', { topic: t(`topics.${found.key}.title`) })
      : t('meta.fallbackTitle'),
    description: found ? t(`topics.${found.key}.intro`) : undefined,
  };
}

export default async function HelpTopicPage({ params }: Props) {
  const { topic } = await params;
  const found = TOPICS.find((x) => x.slug === topic);
  if (!found) notFound();
  const t = await getTranslations('help');

  return (
    <main className="container max-w-2xl py-10">
      <Link
        href="/help"
        className="focus-ring inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> {t('topic.allTopics')}
      </Link>
      <h1 className="mt-4 font-display text-3xl font-bold">{t(`topics.${found.key}.title`)}</h1>
      <p className="mt-1 text-muted-foreground">{t(`topics.${found.key}.intro`)}</p>

      <ul className="mt-8 space-y-6">
        {found.faqs.map((faq) => (
          <li key={faq}>
            <h2 className="font-display text-lg font-semibold">{t(`topics.${found.key}.faqs.${faq}.q`)}</h2>
            <p className="mt-2 text-sm leading-relaxed text-foreground/85">{t(`topics.${found.key}.faqs.${faq}.a`)}</p>
          </li>
        ))}
      </ul>

      <div className="mt-10 rounded-2xl border border-border bg-muted/30 p-5 text-center text-sm">
        {t.rich('topic.stillNeedHelp', {
          email: SUPPORT_EMAIL,
          link: (chunks) => (
            <a className="text-primary underline" href={`mailto:${SUPPORT_EMAIL}`}>{chunks}</a>
          ),
        })}
      </div>
    </main>
  );
}
