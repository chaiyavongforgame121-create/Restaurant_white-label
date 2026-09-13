import Link from 'next/link';
import { AlertTriangle, CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import { Card } from '@favornoms/ui';

export interface SetupStep {
  id: string;
  label: string;
  /** What goes wrong for a customer while this is not done. */
  why: string;
  done: boolean;
  href: string;
  hrefLabel: string;
  /** A read that failed. Shown as "could not check", never as done or not done. */
  error?: string | null;
}

export interface SetupWarning {
  id: string;
  label: string;
  why: string;
  href: string;
  hrefLabel: string;
}

type Mode = 'asap' | 'scheduled';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Whether branches.settings leaves customers at least one way to pay for a delivery or
 * pickup order. Mirrors the Payment methods card's own defaults (an absent cash or card key
 * means ON, transfer is OFF unless ticked) and place-order's refusals (card needs the
 * card_payment entitlement, transfer needs a saved QR image), so this row and that card's
 * "no payment method enabled" warning cannot disagree.
 */
export function paymentMethodOn(settings: Record<string, unknown>, canUseCard: boolean): boolean {
  const matrix = asRecord(settings.payment_methods);
  const hasQr = (() => {
    const url = asRecord(settings.qr_transfer)?.image_url;
    return typeof url === 'string' && url.length > 0;
  })();
  const modes: Mode[] = ['asap', 'scheduled'];
  return modes.some((mode) => {
    const row = asRecord(matrix?.[mode]);
    const readDefaultOn = (key: string) => {
      const v = row?.[key];
      return typeof v === 'boolean' ? v : true;
    };
    return (
      readDefaultOn('cash') ||
      (canUseCard && readDefaultOn('card')) ||
      (hasQr && row?.transfer === true)
    );
  });
}

/**
 * "Get ready to take orders". A store is public the moment onboarding finishes, with an
 * empty menu, no pin and no hours (which the storefront reads as open around the clock),
 * and until this card the only prompt on the dashboard was the trial countdown. The
 * warnings that did exist sat inside Branch settings, in the collapsed Advanced section.
 *
 * Like Action required, nothing is fixed in place: every row links to the screen that owns
 * the setting, so there is one save path and one set of error messages per setting.
 */
export function SetupChecklist({
  steps,
  warnings,
}: {
  steps: SetupStep[];
  warnings: SetupWarning[];
}) {
  const done = steps.filter((s) => s.done && !s.error).length;

  return (
    <section className="mb-6 px-2 lg:px-0">
      <Card className="overflow-hidden">
        <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-4">
          <h2 className="font-display text-lg font-semibold">Get ready to take orders</h2>
          <p className="text-sm text-muted-foreground">
            {done} of {steps.length} done
          </p>
        </header>
        <ul className="border-t border-border">
          {warnings.map((w) => (
            <li key={w.id} className="border-b border-border bg-warning/10">
              <Link
                href={w.href}
                className="focus-ring flex items-start gap-3 px-4 py-3 hover:bg-warning/15"
              >
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{w.label}</span>
                  <span className="block text-sm text-muted-foreground">{w.why}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 self-center text-xs font-semibold text-primary">
                  {w.hrefLabel}
                  <ChevronRight className="h-4 w-4" />
                </span>
              </Link>
            </li>
          ))}
          {steps.map((s) => (
            <li key={s.id} className="border-b border-border last:border-b-0">
              <Link href={s.href} className="focus-ring flex items-start gap-3 px-4 py-3 hover:bg-muted/50">
                {s.done && !s.error ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                ) : (
                  <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm font-semibold ${
                      s.done && !s.error ? 'text-muted-foreground line-through' : ''
                    }`}
                  >
                    {s.label}
                  </span>
                  {s.error ? (
                    <span role="alert" className="block text-sm text-warning">
                      Couldn’t check — {s.error}
                    </span>
                  ) : (
                    !s.done && <span className="block text-sm text-muted-foreground">{s.why}</span>
                  )}
                </span>
                {!(s.done && !s.error) && (
                  <span className="flex shrink-0 items-center gap-1 self-center text-xs font-semibold text-primary">
                    {s.hrefLabel}
                    <ChevronRight className="h-4 w-4" />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
