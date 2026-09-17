import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  ChevronRight, CreditCard, HelpCircle, MapPin, MessageCircle,
  ShieldCheck, ShoppingBag, Tag,
} from 'lucide-react';
import { TOPICS } from './_topics';

const SUPPORT_EMAIL = 'support@favornoms.com';

export async function generateMetadata() {
  const t = await getTranslations('help');
  return {
    title: t('meta.title'),
    description: t('meta.description'),
  };
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'placing-an-order': ShoppingBag,
  'cancel-or-refund': CreditCard,
  'delivery-issues': MapPin,
  'promos-and-loyalty': Tag,
  'account-and-privacy': ShieldCheck,
  'contact-us': MessageCircle,
};

export default async function HelpIndex() {
  const t = await getTranslations('help');
  return (
    <main className="container max-w-3xl py-10">
      <header className="text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
          <HelpCircle className="h-6 w-6" />
        </div>
        <h1 className="mt-4 font-display text-3xl font-bold">{t('index.title')}</h1>
        <p className="mt-2 text-muted-foreground">
          {t('index.subtitle')}
        </p>
      </header>

      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TOPICS.map((topic) => {
          const Icon = ICONS[topic.slug] ?? HelpCircle;
          return (
            <Link
              key={topic.slug}
              href={`/help/${topic.slug}`}
              className="focus-ring flex items-start justify-between gap-3 rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-warm"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="font-display text-base font-semibold">{t(`topics.${topic.key}.title`)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t(`topics.${topic.key}.intro`)}</p>
                </div>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </div>

      <div className="mt-10 rounded-2xl border border-border bg-muted/30 p-5 text-center">
        <h2 className="font-display text-lg font-semibold">{t('index.stillNeedHelp')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t.rich('index.emailUs', {
            email: SUPPORT_EMAIL,
            link: (chunks) => (
              <a className="text-primary underline" href={`mailto:${SUPPORT_EMAIL}`}>{chunks}</a>
            ),
          })}
        </p>
      </div>
    </main>
  );
}
