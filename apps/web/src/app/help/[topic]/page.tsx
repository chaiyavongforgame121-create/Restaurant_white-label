import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { TOPICS } from '../_topics';

interface Props {
  params: Promise<{ topic: string }>;
}

export function generateStaticParams() {
  return TOPICS.map((t) => ({ topic: t.slug }));
}

export async function generateMetadata({ params }: Props) {
  const { topic } = await params;
  const t = TOPICS.find((x) => x.slug === topic);
  return {
    title: t ? `${t.title} · Help · Favornoms` : 'Help · Favornoms',
    description: t?.intro,
  };
}

export default async function HelpTopicPage({ params }: Props) {
  const { topic } = await params;
  const t = TOPICS.find((x) => x.slug === topic);
  if (!t) notFound();

  return (
    <main className="container max-w-2xl py-10">
      <Link
        href="/help"
        className="focus-ring inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> All topics
      </Link>
      <h1 className="mt-4 font-display text-3xl font-bold">{t.title}</h1>
      <p className="mt-1 text-muted-foreground">{t.intro}</p>

      <ul className="mt-8 space-y-6">
        {t.faqs.map((faq, i) => (
          <li key={i}>
            <h2 className="font-display text-lg font-semibold">{faq.q}</h2>
            <p className="mt-2 text-sm leading-relaxed text-foreground/85">{faq.a}</p>
          </li>
        ))}
      </ul>

      <div className="mt-10 rounded-2xl border border-border bg-muted/30 p-5 text-center text-sm">
        Didn&apos;t find what you needed? Email{' '}
        <a className="text-primary underline" href="mailto:support@favornoms.com">support@favornoms.com</a>
        .
      </div>
    </main>
  );
}
