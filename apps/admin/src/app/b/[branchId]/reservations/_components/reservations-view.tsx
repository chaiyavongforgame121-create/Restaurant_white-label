'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, CheckCircle2, XCircle, ChefHat, Clock, User } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import {
  setReservationStatus,
  type ReservationRow,
  type ReservationStatus,
} from '@favornoms/database/queries';

interface Props {
  branchId: string;
  initialRows: ReservationRow[];
}

const statusOrder: ReservationStatus[] = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'];

function fmtWhen(s: string) {
  return new Date(s).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function variantFor(status: ReservationStatus) {
  switch (status) {
    case 'pending':
      return 'warning' as const;
    case 'confirmed':
      return 'success' as const;
    case 'seated':
      return 'success' as const;
    case 'completed':
      return 'muted' as const;
    case 'cancelled':
      return 'danger' as const;
    case 'no_show':
      return 'danger' as const;
    default:
      return 'muted' as const;
  }
}

export function ReservationsView({ branchId, initialRows }: Props) {
  const router = useRouter();
  const [rows, setRows] = React.useState(initialRows);
  const [filter, setFilter] = React.useState<'all' | ReservationStatus>('pending');

  React.useEffect(() => {
    const supabase = getBrowserClient();
    const channel = supabase
      .channel(`admin-reservations-${branchId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reservations', filter: `branch_id=eq.${branchId}` },
        () => router.refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [branchId, router]);

  const visible = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  const updateStatus = async (id: string, status: ReservationStatus) => {
    setRows((curr) => curr.map((r) => (r.id === id ? { ...r, status } : r)));
    const supabase = getBrowserClient();
    await setReservationStatus(supabase, id, status);
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Reservations</h1>
          <p className="mt-1 text-muted-foreground">{rows.length} upcoming · live updates</p>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap gap-2 px-2 lg:px-0">
        <button
          onClick={() => setFilter('all')}
          className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
            filter === 'all'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:border-primary/40'
          }`}
        >
          All
        </button>
        {statusOrder.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
              filter === s
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:border-primary/40'
            }`}
          >
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Calendar className="h-7 w-7" />}
          title="No reservations match"
          description="When customers book a table from your website it'll appear here in real time."
        />
      ) : (
        <ul className="space-y-2 px-2 lg:px-0">
          {visible.map((r) => (
            <li key={r.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <p className="font-display text-lg font-semibold">{fmtWhen(r.reserved_for)}</p>
                      <Badge variant="muted">{r.party_size} pax</Badge>
                      <Badge variant={variantFor(r.status)}>{r.status.replace('_', ' ')}</Badge>
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <User className="h-3.5 w-3.5" /> {r.customer_name}
                      <span>·</span>
                      <a className="text-primary" href={`tel:${r.customer_phone}`}>
                        {r.customer_phone}
                      </a>
                    </p>
                    {r.notes && (
                      <p className="mt-1 max-w-prose text-xs italic text-muted-foreground">
                        “{r.notes}”
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {r.status === 'pending' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          leftIcon={<XCircle className="h-4 w-4" />}
                          onClick={() => updateStatus(r.id, 'cancelled')}
                        >
                          Decline
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          leftIcon={<CheckCircle2 className="h-4 w-4" />}
                          onClick={() => updateStatus(r.id, 'confirmed')}
                        >
                          Confirm
                        </Button>
                      </>
                    )}
                    {r.status === 'confirmed' && (
                      <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<ChefHat className="h-4 w-4" />}
                        onClick={() => updateStatus(r.id, 'seated')}
                      >
                        Mark seated
                      </Button>
                    )}
                    {r.status === 'seated' && (
                      <Button size="sm" variant="primary" onClick={() => updateStatus(r.id, 'completed')}>
                        Complete
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
