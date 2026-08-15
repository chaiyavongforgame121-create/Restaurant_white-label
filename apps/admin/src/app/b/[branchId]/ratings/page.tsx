import { getServerClient } from '@favornoms/database/server';
import { getBranchRatings } from '@favornoms/database/queries';
import { Card, EmptyState } from '@favornoms/ui';
import { AlertTriangle, Bike, MessageSquare, Star, UtensilsCrossed } from 'lucide-react';

interface Props { params: Promise<{ branchId: string }> }

export default async function RatingsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { ratings, foodAvg, foodCount, deliveryAvg, deliveryCount, total, error } =
    await getBranchRatings(supabase, branchId);

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Ratings</h1>
        <p className="mt-1 text-muted-foreground">What guests said after their orders</p>
      </header>

      <div className="space-y-5 px-2 lg:px-0">
        {error && (
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
              <AlertTriangle className="h-5 w-5" /> Ratings could not be loaded
            </h2>
            <p className="mt-3 break-words rounded-xl bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
              {error}
            </p>
          </Card>
        )}

        <section className="grid gap-3 sm:grid-cols-3">
          <ScoreCard
            icon={<UtensilsCrossed className="h-5 w-5" />}
            label="Food rating"
            value={foodAvg}
            sub={`${foodCount} rating${foodCount === 1 ? '' : 's'}`}
          />
          <ScoreCard
            icon={<Bike className="h-5 w-5" />}
            label="Delivery rating"
            value={deliveryAvg}
            sub={`${deliveryCount} rating${deliveryCount === 1 ? '' : 's'}`}
          />
          <Card className="flex items-center gap-3 p-4">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total reviews</p>
              <p className="font-display text-2xl font-bold tabular-nums">{total}</p>
            </div>
          </Card>
        </section>

        {ratings.length === 0 && !error ? (
          <EmptyState
            icon={<Star className="h-7 w-7" />}
            title="No ratings yet"
            description="Guests are asked to rate an order once it's completed — their stars and comments land here."
          />
        ) : (
          <ul className="space-y-3">
            {ratings.map((r) => (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {r.food_stars != null && <Stars label="Food" value={r.food_stars} />}
                      {r.delivery_stars != null && <Stars label="Delivery" value={r.delivery_stars} />}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p className="font-mono">{r.order_number ?? '—'}</p>
                      <p>
                        {new Date(r.created_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </p>
                    </div>
                  </div>
                  {r.comment && <p className="mt-3 text-sm">&ldquo;{r.comment}&rdquo;</p>}
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

function Stars({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="inline-flex" aria-label={`${value} out of 5`}>
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
