import { getLocale, getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import { getBranchRatings } from '@favornoms/database/queries';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Card, EmptyState, RiderIcon } from '@favornoms/ui';
import { AlertTriangle, MessageSquare, Star, UtensilsCrossed } from 'lucide-react';

interface Props { params: Promise<{ branchId: string }> }

export default async function RatingsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const [t, rawLocale] = await Promise.all([getTranslations('ratings'), getLocale()]);
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const { ratings, foodAvg, foodCount, deliveryAvg, deliveryCount, total, drivers, error } =
    await getBranchRatings(supabase, branchId);

  // The raw PostgREST text is for the logs; the merchant reads what it means for them.
  if (error) console.error('Loading branch ratings failed', error);
  const errorMessage = error
    ? /\b42501\b|permission denied|row-level security/i.test(error)
      ? t('loadError.permission')
      : t('loadError.generic')
    : null;

  const dateFormat = new Intl.DateTimeFormat(intlLocaleFor(locale), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
      </header>

      <div className="space-y-5 px-2 lg:px-0">
        {errorMessage && (
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
              <AlertTriangle className="h-5 w-5" /> {t('loadError.title')}
            </h2>
            <p className="mt-3 break-words rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {errorMessage}
            </p>
          </Card>
        )}

        <section className="grid gap-3 sm:grid-cols-3">
          <ScoreCard
            icon={<UtensilsCrossed className="h-5 w-5" />}
            label={t('score.food')}
            value={foodAvg}
            sub={t('score.count', { count: foodCount })}
          />
          <ScoreCard
            icon={<RiderIcon className="h-5 w-5" />}
            label={t('score.delivery')}
            value={deliveryAvg}
            sub={t('score.count', { count: deliveryCount })}
          />
          <Card className="flex items-center gap-3 p-4">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('score.total')}</p>
              <p className="font-display text-2xl font-bold tabular-nums">{total}</p>
            </div>
          </Card>
        </section>

        {drivers.length > 0 && (
          <section>
            <h2 className="mb-3 font-display text-lg font-semibold">{t('riders.title')}</h2>
            {/* The branch-wide delivery average above hides who is earning it. This is the
                same rows grouped per rider, so a merchant can tell one rider's run of one
                stars from a bad week across the board. */}
            <ul className="grid gap-3 sm:grid-cols-2">
              {drivers.map((d) => (
                <li key={d.driver_id}>
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                          <RiderIcon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {d.name ?? t('riders.fallbackName', { id: d.driver_id.slice(0, 8) })}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t('riders.rated', { count: d.count })}
                          </p>
                        </div>
                      </div>
                      <p className="shrink-0 font-display text-2xl font-bold tabular-nums">
                        {d.avg != null ? d.avg.toFixed(1) : '—'}
                        {d.avg != null && (
                          <span className="text-sm font-medium text-muted-foreground"> / 5</span>
                        )}
                      </p>
                    </div>

                    {d.count > 0 && (
                      <ul className="mt-3 space-y-1">
                        {[5, 4, 3, 2, 1].map((star) => {
                          const n = d.distribution[star - 1] ?? 0;
                          return (
                            <li key={star} className="flex items-center gap-2 text-xs">
                              <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                                {star}★
                              </span>
                              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                                <span
                                  className="block h-full rounded-full bg-warning"
                                  style={{ width: `${d.count ? (n / d.count) * 100 : 0}%` }}
                                />
                              </span>
                              <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">
                                {n}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {d.comments.length > 0 && (
                      <ul className="mt-3 space-y-2 border-t border-border pt-3">
                        {d.comments.slice(0, 3).map((c) => (
                          <li key={c.id} className="text-sm">
                            <span className="mr-2 font-mono text-xs text-muted-foreground">
                              {c.order_number ?? '—'}
                            </span>
                            &ldquo;{c.comment}&rdquo;
                          </li>
                        ))}
                        {d.comments.length > 3 && (
                          <li className="text-xs text-muted-foreground">
                            {t('riders.more', { count: d.comments.length - 3 })}
                          </li>
                        )}
                      </ul>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        )}

        {ratings.length === 0 && !error ? (
          <EmptyState
            icon={<Star className="h-7 w-7" />}
            title={t('empty.title')}
            description={t('empty.description')}
          />
        ) : (
          <ul className="space-y-3">
            {ratings.map((r) => (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {r.food_stars != null && (
                        <Stars
                          label={t('stars.food')}
                          ariaLabel={t('stars.outOfFive', { value: r.food_stars })}
                          value={r.food_stars}
                        />
                      )}
                      {r.delivery_stars != null && (
                        <Stars
                          label={t('stars.delivery')}
                          ariaLabel={t('stars.outOfFive', { value: r.delivery_stars })}
                          value={r.delivery_stars}
                        />
                      )}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p className="font-mono">{r.order_number ?? '—'}</p>
                      <p>{dateFormat.format(new Date(r.created_at))}</p>
                    </div>
                  </div>
                  {r.comment && <p className="mt-3 text-sm">&ldquo;{r.comment}&rdquo;</p>}
                  {r.driver_comment && (
                    // Kept visibly apart from the food comment: they are two different
                    // questions, and reading a complaint about the ride as a complaint
                    // about the kitchen sends the merchant after the wrong problem.
                    <p className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
                      <RiderIcon className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        &ldquo;{r.driver_comment}&rdquo;
                        {r.driver_name && (
                          <span className="ml-1 text-xs">
                            {t('aboutRider', { name: r.driver_name })}
                          </span>
                        )}
                      </span>
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ScoreCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  sub: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-display text-2xl font-bold tabular-nums">
          {value != null ? value.toFixed(1) : '—'}
          {value != null && <span className="text-sm font-medium text-muted-foreground"> / 5</span>}
        </p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
    </Card>
  );
}

function Stars({ label, ariaLabel, value }: { label: string; ariaLabel: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="inline-flex" aria-label={ariaLabel}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={
              n <= value ? 'h-4 w-4 fill-warning text-warning' : 'h-4 w-4 text-muted-foreground/40'
            }
          />
        ))}
      </span>
    </span>
  );
}
