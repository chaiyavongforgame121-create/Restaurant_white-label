'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Download, DollarSign } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface Shift {
  id: string;
  staff_member_id: string;
  clocked_in_at: string;
  clocked_out_at: string | null;
  shift_role: string | null;
  notes: string | null;
}

interface Staff {
  id: string;
  role: string;
  status: string;
  user_id: string | null;
  invited_email: string | null;
}

interface TipRow {
  staff_member_id: string;
  staff_email: string | null;
  hours: number;
  share: number;
  payout: number;
}

interface Props {
  branchId: string;
  shifts: Shift[];
  staff: Staff[];
}

export function ShiftsView({ branchId, shifts, staff }: Props) {
  const router = useRouter();
  const staffById = React.useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  const [error, setError] = React.useState<string | null>(null);
  const [tipFrom, setTipFrom] = React.useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [tipTo, setTipTo] = React.useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 16);
  });
  const [tipRows, setTipRows] = React.useState<TipRow[] | null>(null);
  const [tipBusy, setTipBusy] = React.useState(false);

  const closeShift = async (shiftId: string) => {
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('clock_out', { p_shift_id: shiftId });
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    router.refresh();
  };

  const computeHours = (s: Shift) => {
    const start = new Date(s.clocked_in_at).getTime();
    const end = s.clocked_out_at ? new Date(s.clocked_out_at).getTime() : Date.now();
    return Math.max(0, (end - start) / 3_600_000);
  };

  const totalHours = shifts.reduce((sum, s) => sum + computeHours(s), 0);
  const openShifts = shifts.filter((s) => !s.clocked_out_at).length;

  const calculateTips = async () => {
    setTipBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data, error: rpcErr } = await supabase.rpc('tip_pool_distribution', {
      p_branch_id: branchId,
      p_from: new Date(tipFrom).toISOString(),
      p_to: new Date(tipTo).toISOString(),
    });
    setTipBusy(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    setTipRows((data ?? []) as TipRow[]);
  };

  const exportShiftsCsv = () => {
    const rows = [
      ['Staff', 'Role', 'Clock in', 'Clock out', 'Hours', 'Notes'],
      ...shifts.map((s) => {
        const sm = staffById.get(s.staff_member_id);
        return [
          sm?.invited_email ?? sm?.user_id ?? s.staff_member_id,
          sm?.role ?? '',
          s.clocked_in_at,
          s.clocked_out_at ?? '',
          computeHours(s).toFixed(2),
          s.notes ?? '',
        ];
      }),
    ];
    downloadCsv(rows, `shifts-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const exportTipsCsv = () => {
    if (!tipRows) return;
    const rows = [
      ['Staff', 'Hours', 'Share %', 'Payout (USD)'],
      ...tipRows.map((r) => [r.staff_email ?? r.staff_member_id, r.hours.toFixed(2), (r.share * 100).toFixed(2), r.payout.toFixed(2)]),
    ];
    downloadCsv(rows, `tips-${tipFrom.slice(0, 10)}.csv`);
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Shifts & tips</h1>
          <p className="mt-1 text-muted-foreground">
            Staff clock in/out, hours, and tip pool distribution.
          </p>
        </div>
        <Button variant="ghost" onClick={exportShiftsCsv} leftIcon={<Download className="h-4 w-4" />}>
          Export shifts CSV
        </Button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      <div className="mb-6 grid grid-cols-3 gap-4 px-2 lg:px-0">
        <Stat label="Open shifts" value={String(openShifts)} icon={Clock} />
        <Stat label="Hours this week" value={totalHours.toFixed(1)} icon={Clock} />
        <Stat label="Active staff" value={String(staff.length)} icon={Clock} />
      </div>

      <Card className="mb-6 overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-3">Staff</th>
              <th className="px-5 py-3">Role</th>
              <th className="px-5 py-3">Clock in</th>
              <th className="px-5 py-3">Clock out</th>
              <th className="px-5 py-3 text-right">Hours</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {shifts.map((s) => {
              const sm = staffById.get(s.staff_member_id);
              const open = !s.clocked_out_at;
              return (
                <tr key={s.id} className="border-t border-border/40">
                  <td className="px-5 py-3 font-medium">{sm?.invited_email ?? sm?.user_id?.slice(0, 8) ?? '—'}</td>
                  <td className="px-5 py-3 text-muted-foreground">{s.shift_role ?? '—'}</td>
                  <td className="px-5 py-3 text-muted-foreground">{new Date(s.clocked_in_at).toLocaleString()}</td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {s.clocked_out_at ? new Date(s.clocked_out_at).toLocaleString() : <Badge variant="warning">In progress</Badge>}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{computeHours(s).toFixed(2)}</td>
                  <td className="px-5 py-3 text-right">
                    {open && (
                      <Button size="sm" variant="ghost" onClick={() => closeShift(s.id)}>Force clock out</Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {shifts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">No shifts in the last 7 days.</td>
              </tr>
            )}
          </tbody>
        </table></div>
      </Card>

      <Card className="p-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <DollarSign className="h-5 w-5 text-primary" /> Tip pool distribution
          </h2>
          {tipRows && tipRows.length > 0 && (
            <Button variant="ghost" size="sm" onClick={exportTipsCsv} leftIcon={<Download className="h-3.5 w-3.5" />}>
              Export CSV
            </Button>
          )}
        </header>
        <p className="text-sm text-muted-foreground">
          Splits total tips for the date range across staff by hours worked.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium">From</span>
            <input type="datetime-local" value={tipFrom} onChange={(e) => setTipFrom(e.target.value)} className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium">To</span>
            <input type="datetime-local" value={tipTo} onChange={(e) => setTipTo(e.target.value)} className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
          </label>
          <div className="flex items-end">
            <Button variant="gradient" onClick={calculateTips} loading={tipBusy}>
              Calculate
            </Button>
          </div>
        </div>

        {tipRows && (
          tipRows.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No tips or no logged hours in this range.</p>
          ) : (
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2 text-right">Hours</th>
                  <th className="px-3 py-2 text-right">Share</th>
                  <th className="px-3 py-2 text-right">Payout</th>
                </tr>
              </thead>
              <tbody>
                {tipRows.map((r) => (
                  <tr key={r.staff_member_id} className="border-t border-border/40">
                    <td className="px-3 py-2">{r.staff_email ?? r.staff_member_id.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(r.hours).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{(Number(r.share) * 100).toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right font-semibold text-primary tabular-nums">{formatCurrency(Number(r.payout))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-display text-xl font-bold">{value}</p>
      </div>
    </Card>
  );
}

function downloadCsv(rows: (string | number)[][], filename: string) {
  const csv = rows
    .map((r) =>
      r.map((c) => {
        const s = String(c);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','),
    )
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
