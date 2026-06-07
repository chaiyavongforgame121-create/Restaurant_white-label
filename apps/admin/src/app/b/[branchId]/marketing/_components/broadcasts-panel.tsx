'use client';

import * as React from 'react';
import { Megaphone, Send } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, EmptyState } from '@favornoms/ui';

interface Broadcast {
  id: string;
  title: string;
  body: string;
  url: string | null;
  status: string;
  recipient_count: number;
  sent_at: string | null;
  scheduled_for: string | null;
  audience: Record<string, unknown> | null;
  channels: string[];
  created_at: string;
}

const TIERS = ['bronze', 'silver', 'gold', 'platinum'] as const;

export function BroadcastsPanel({
  branchId,
  initialBroadcasts,
}: {
  branchId: string;
  initialBroadcasts: Broadcast[];
}) {
  const [list, setList] = React.useState(initialBroadcasts);
  const [composing, setComposing] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [tiers, setTiers] = React.useState<string[]>([]);
  const [recencyDays, setRecencyDays] = React.useState<string>('');
  const [consentOnly, setConsentOnly] = React.useState(true);
  const [channels, setChannels] = React.useState<string[]>(['push', 'in_app']);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const audience: Record<string, unknown> = {};
    if (tiers.length > 0) audience.tiers = tiers;
    if (recencyDays) audience.last_order_within_days = Number(recencyDays);
    if (consentOnly) audience.marketing_consent_only = true;

    const { data: created, error: insertError } = await supabase
      .from('broadcasts')
      .insert({
        branch_id: branchId,
        title,
        body,
        url: url || null,
        audience,
        channels,
      })
      .select()
      .single();
    if (insertError || !created) {
      setBusy(false);
      setError(insertError?.message ?? 'failed_to_create');
      return;
    }

    const { error: rpcError } = await supabase.rpc('enqueue_broadcast', {
      p_broadcast_id: created.id,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setTitle('');
    setBody('');
    setUrl('');
    setTiers([]);
    setRecencyDays('');
    setComposing(false);

    const { data: refreshed } = await supabase
      .from('broadcasts')
      .select('id, title, body, url, status, recipient_count, sent_at, scheduled_for, audience, channels, created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (refreshed) setList(refreshed as Broadcast[]);
  };

  const toggle = (arr: string[], val: string, setter: (v: string[]) => void) => {
    setter(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Marketing</h1>
          <p className="mt-1 text-muted-foreground">Broadcast promotions to segmented customers.</p>
        </div>
        <Button onClick={() => setComposing((c) => !c)} variant={composing ? 'ghost' : 'gradient'}>
          {composing ? 'Cancel' : 'New broadcast'}
        </Button>
      </header>

      {composing && (
        <Card className="mb-6 space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold">Compose broadcast</h2>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" maxLength={200} />
          </Field>
          <Field label="Body">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} className="input min-h-24 py-3" maxLength={1000} />
          </Field>
          <Field label="URL (optional)">
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="input" placeholder="https://…" />
          </Field>

          <Card className="space-y-3 bg-muted/30 p-4">
            <p className="text-sm font-medium">Audience</p>
            <div className="flex flex-wrap gap-2">
              {TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggle(tiers, t, setTiers)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition ${
                    tiers.includes(t)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background'
                  }`}
                >
                  {t}
                </button>
              ))}
              {tiers.length === 0 && <span className="text-xs text-muted-foreground">No tier filter — all customers</span>}
            </div>
            <Field label="Ordered within last N days (optional)">
              <input
                value={recencyDays}
                onChange={(e) => setRecencyDays(e.target.value.replace(/\D/g, ''))}
                className="input"
                placeholder="e.g. 30"
                inputMode="numeric"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={consentOnly}
                onChange={(e) => setConsentOnly(e.target.checked)}
              />
              Only customers who opted in to marketing
            </label>
          </Card>

          <Card className="space-y-2 bg-muted/30 p-4">
            <p className="text-sm font-medium">Channels</p>
            <div className="flex flex-wrap gap-2">
              {(['push', 'in_app', 'sms'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggle(channels, c, setChannels)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium uppercase transition ${
                    channels.includes(c)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </Card>

          {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

          <Button
            variant="gradient"
            size="xl"
            onClick={send}
            disabled={!title || !body || channels.length === 0}
            loading={busy}
            leftIcon={<Send className="h-4 w-4" />}
          >
            Send now
          </Button>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="h-7 w-7" />}
          title="No broadcasts yet"
          description="Compose a new broadcast to reach segmented customers via push or SMS."
        />
      ) : (
        <Card className="divide-y divide-border/40">
          {list.map((b) => (
            <div key={b.id} className="flex items-start justify-between p-4">
              <div className="min-w-0">
                <p className="font-medium">{b.title}</p>
                <p className="line-clamp-2 text-sm text-muted-foreground">{b.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {b.channels.join(' + ')} · {new Date(b.created_at).toLocaleString()}
                </p>
              </div>
              <div className="ml-4 text-right">
                <Badge
                  variant={
                    b.status === 'sent' ? 'success' : b.status === 'failed' ? 'danger' : 'muted'
                  }
                >
                  {b.status}
                </Badge>
                <p className="mt-1 text-xs text-muted-foreground">{b.recipient_count} recipients</p>
              </div>
            </div>
          ))}
        </Card>
      )}

      <style jsx>{`
        .input {
          width: 100%;
          min-height: 48px;
          padding: 0 1rem;
          font-size: 16px;
          border-radius: 0.875rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
        }
        .input:focus-visible {
          outline: none;
          border-color: hsl(var(--primary));
          box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
