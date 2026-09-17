'use client';

import * as React from 'react';
import { CalendarClock, Check, Power, Store } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Sheet, cn } from '@favornoms/ui';
import { ScheduleEditor } from '@/components/schedule-editor';

// The single "Go online" entry point. Two modes:
//  • Online now  — pick which approved restaurants can dispatch to you, then go
//    online for exactly those (an unpicked branch can't send work).
//  • Schedule    — set recurring open/close windows (reuses ScheduleEditor).
// The parent (HomeView) owns the actual online RPCs via onApply so the button
// and this sheet share one code path.

interface ApprovedBranch {
  branch_id: string;
  name: string;
}

export function AvailabilitySheet({
  open,
  onClose,
  approved,
  initialScope,
  isOnline,
  applying,
  blocked = false,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  approved: ApprovedBranch[];
  initialScope: string[];
  isOnline: boolean;
  applying: boolean;
  /** True while a penalty cooldown blocks going online. */
  blocked?: boolean;
  onApply: (ids: string[]) => void | Promise<void>;
}) {
  const t = useTranslations('home');
  const [tab, setTab] = React.useState<'now' | 'schedule'>('now');
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());

  // Seed the checklist each time the sheet opens: remembered scope, or all
  // approved when nothing's been chosen yet.
  //
  // Only on the transition into open. Seeding whenever `approved` or `initialScope` changed
  // identity re-ran it under the rider's thumb — every re-render of Home reset their ticks
  // and pulled them off the Schedule tab — and a re-seed while the sheet is open is never
  // what anyone wants anyway: it throws away the choice they are in the middle of making.
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current) return;
    seededRef.current = true;
    const seed = initialScope.filter((id) => approved.some((a) => a.branch_id === id));
    setSelected(new Set(seed.length ? seed : approved.map((a) => a.branch_id)));
    setTab('now');
  }, [open, initialScope, approved]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOn = approved.length > 0 && approved.every((a) => selected.has(a.branch_id));
  const canGo = selected.size > 0 && !blocked;

  return (
    <Sheet open={open} onClose={onClose} title={t('goOnline')} className="max-h-[92dvh]">
      <div className="px-5 pb-8 pt-1">
        {/* Mode tabs */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-muted/60 p-1">
          {(
            [
              ['now', t('sheet.tabNow'), Power],
              ['schedule', t('sheet.tabSchedule'), CalendarClock],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition',
                tab === key ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground',
              )}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {tab === 'now' ? (
          <div>
            <p className="mb-3 text-sm text-muted-foreground">{t('sheet.intro')}</p>
            <button
              type="button"
              onClick={() =>
                setSelected(allOn ? new Set() : new Set(approved.map((a) => a.branch_id)))
              }
              className="mb-2 text-sm font-medium text-primary"
            >
              {allOn ? t('sheet.clearAll') : t('sheet.selectAll')}
            </button>
            <ul className="space-y-2">
              {approved.map((a) => {
                const on = selected.has(a.branch_id);
                return (
                  <li key={a.branch_id}>
                    <button
                      type="button"
                      onClick={() => toggle(a.branch_id)}
                      aria-pressed={on}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition',
                        on ? 'border-primary bg-primary/5' : 'border-border bg-card',
                      )}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                        <Store className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                      <span
                        className={cn(
                          'grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition',
                          on ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                        )}
                      >
                        {on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <Button
              fullWidth
              size="lg"
              className="mt-5"
              loading={applying}
              disabled={!canGo}
              leftIcon={<Power className="h-4 w-4" />}
              onClick={() => void onApply([...selected])}
            >
              {isOnline ? t('sheet.update') : t('goOnline')}
            </Button>
            {blocked ? (
              <p className="mt-2 text-center text-xs text-danger">{t('sheet.cooldown')}</p>
            ) : (
              selected.size === 0 && (
                <p className="mt-2 text-center text-xs text-muted-foreground">{t('sheet.pickOne')}</p>
              )
            )}
          </div>
        ) : (
          <ScheduleEditor />
        )}
      </div>
    </Sheet>
  );
}
