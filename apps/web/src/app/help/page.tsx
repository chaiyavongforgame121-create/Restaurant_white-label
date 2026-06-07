import Link from 'next/link';
import {
  ChevronRight, CreditCard, HelpCircle, MapPin, MessageCircle,
  ShieldCheck, ShoppingBag, Tag,
} from 'lucide-react';
import { TOPICS } from './_topics';

export const metadata = {
  title: 'Help center · Favornoms',
  description: 'Common questions about ordering, refunds, payments, account, and privacy.',
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'placing-an-order': ShoppingBag,
  'cancel-or-refund': CreditCard,
  'delivery-issues': MapPin,
  'promos-and-loyalty': Tag,
  'account-and-privacy': ShieldCheck,
  'contact-us': MessageCircle,
};

export default function HelpIndex() {
  return (
    <main className="container max-w-3xl py-10">
      <header className="text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
          <HelpCircle className="h-6 w-6" />
        </div>
        <h1 className="mt-4 font-display text-3xl font-bold">Help center</h1>
        <p className="mt-2 text-muted-foreground">
          Quick answers to the most common questions. Can&apos;t find what you need? Email us.
        </p>
      </header>

      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TOPICS.map((t) => {
          const Icon = ICONS[t.slug] ?? HelpCircle;
          return (
            <Link
              key={t.slug}
              href={`/help/${t.slug}`}
              className="focus-ring flex items-start justify-between gap-3 rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-warm"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="font-display text-base font-semibold">{t.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.intro}</p>
                </div>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </div>

      <div className="mt-10 rounded-2xl border border-border bg-muted/30 p-5 text-center">
        <h2 className="font-display text-lg font-semibold">Still need help?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Email{' '}
          <a className="text-primary underline" href="mailto:support@favornoms.com">support@favornoms.com</a>
          {' '}— we usually reply within a few hours.
        </p>
      </div>
    </main>
  );
}
