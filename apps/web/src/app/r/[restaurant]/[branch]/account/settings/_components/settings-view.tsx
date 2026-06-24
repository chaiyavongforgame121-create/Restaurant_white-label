'use client';

import * as React from 'react';
import { Bell, Moon, Save, Sun, User } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card, useTheme } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { AccountHeader, SignInGate } from '../../_components/account-ui';

export function SettingsView({ base, branchId }: { base: string; branchId: string }) {
  const { user, loading } = useAuth();
  const { mode, toggleMode } = useTheme();

  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [fullName, setFullName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [marketing, setMarketing] = React.useState(false);
  const [loadingData, setLoadingData] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) {
      setLoadingData(false);
      return;
    }
    const supabase = getBrowserClient();
    // One customer identity per restaurant (shared across branches); resolve/create it.
    void supabase
      .rpc('get_or_create_my_customer', { p_branch_id: branchId })
      .then(async ({ data: cid }) => {
        const customerIdResolved = cid as string | null;
        if (!customerIdResolved) {
          setLoadingData(false);
          return;
        }
        const { data } = await supabase
          .from('customers')
          .select('id, full_name, phone, email, marketing_consent')
          .eq('id', customerIdResolved)
          .maybeSingle();
        if (data) {
          setCustomerId(data.id);
          setFullName(data.full_name ?? '');
          setPhone(data.phone ?? '');
          setEmail(data.email ?? '');
          setMarketing(!!data.marketing_consent);
        }
        setLoadingData(false);
      });
  }, [user, branchId]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const supabase = getBrowserClient();
    const { error: dbErr } = await supabase
      .from('customers')
      .update({
        full_name: fullName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim().toLowerCase() || null,
        marketing_consent: marketing,
      })
      .eq('id', customerId);
    setSaving(false);
    if (dbErr) {
      setError(dbErr.message);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="container max-w-2xl pb-24 pt-4">
      <AccountHeader base={base} title="Settings & preferences" />
      {loading ? null : !user ? (
        <SignInGate base={base} message="Sign in to manage your profile and preferences." />
      ) : (
        <form className="space-y-5" onSubmit={save}>
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <User className="h-5 w-5 text-primary" /> Your profile
            </h2>
            <div className="mt-3 space-y-3">
              <Field label="Full name">
                <input
                  className="input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Jordan Smith"
                  autoComplete="name"
                />
              </Field>
              <Field label="Phone">
                <input
                  className="input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                  inputMode="tel"
                  placeholder="(555) 234-5678"
                  autoComplete="tel"
                />
              </Field>
              <Field label="Email">
                <input
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </Field>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Bell className="h-5 w-5 text-primary" /> Notifications
            </h2>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Promotions &amp; offers</p>
                <p className="text-xs text-muted-foreground">Get deals, rewards and news by email.</p>
              </div>
              <Toggle on={marketing} onClick={() => setMarketing((m) => !m)} label="Promotions and offers" />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">Appearance</h2>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                {mode === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                {mode === 'dark' ? 'Dark mode' : 'Light mode'}
              </span>
              <Toggle on={mode === 'dark'} onClick={toggleMode} label="Dark mode" />
            </div>
          </Card>

          {error && (
            <Card className="border-danger/30 bg-danger/5 p-4 text-sm text-danger">{error}</Card>
          )}

          {!loadingData && !customerId && (
            <Card className="border-warning/30 bg-warning/5 p-4 text-sm text-muted-foreground">
              We couldn&apos;t find your profile yet — place your first order to set it up. Your
              appearance preference above still saves.
            </Card>
          )}

          <Button
            type="submit"
            variant="gradient"
            size="xl"
            fullWidth
            loading={saving}
            leftIcon={<Save className="h-4 w-4" />}
            disabled={!customerId || loadingData}
          >
            {saved ? 'Saved ✓' : 'Save changes'}
          </Button>
        </form>
      )}

      <style jsx global>{`
        .input {
          width: 100%;
          height: 48px;
          padding: 0 1rem;
          font-size: 16px;
          border-radius: 0.875rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input:focus-visible {
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
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        on ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          on ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
