'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Bell, Moon, Save, Sun, User } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card, useTheme } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { customerErrorKey, resolveMyCustomerId } from '@/lib/customer';
import { AccountHeader, SignInGate } from '../../_components/account-ui';

/** The `account.*` messages this page can show for a failed load or save. */
type SettingsErrorKey =
  | 'settings.saveFailed'
  | 'settings.phoneTaken'
  | 'errors.sessionExpired'
  | 'errors.branchNotFound'
  | 'errors.profileUnavailable'
  | 'errors.generic';

/** An identity failure we can name, else a generic line — never the raw database message. */
function settingsErrorKey(err: unknown): SettingsErrorKey {
  const customer = customerErrorKey(err);
  return customer ? `errors.${customer}` : 'errors.generic';
}

export function SettingsView({ base, branchId }: { base: string; branchId: string }) {
  const t = useTranslations('account');
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
  // Held as a message key and translated at render.
  const [error, setError] = React.useState<SettingsErrorKey | null>(null);

  React.useEffect(() => {
    if (!user) {
      setLoadingData(false);
      return;
    }
    let cancelled = false;
    const supabase = getBrowserClient();
    void (async () => {
      try {
        // One customer identity per restaurant (shared across branches); resolve/create it.
        // Checkout resolves the same way, so what's saved here is what's prefilled there.
        const cid = await resolveMyCustomerId(branchId);
        if (cancelled) return;
        setCustomerId(cid);
        const { data, error: dbErr } = await supabase
          .from('customers')
          .select('id, full_name, phone, email, marketing_consent')
          .eq('id', cid)
          .maybeSingle();
        if (cancelled) return;
        if (dbErr) throw new Error(dbErr.message);
        if (data) {
          setFullName(data.full_name ?? '');
          setPhone(data.phone ?? '');
          setEmail(data.email ?? '');
          setMarketing(!!data.marketing_consent);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[settings] loading the profile failed', err);
          setError(settingsErrorKey(err));
        }
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, branchId]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const supabase = getBrowserClient();
    // `.select()` on the update is deliberate: an RLS-blocked update returns no
    // error and zero rows, which used to look like a successful save.
    const { data, error: dbErr } = await supabase
      .from('customers')
      .update({
        full_name: fullName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim().toLowerCase() || null,
        marketing_consent: marketing,
      })
      .eq('id', customerId)
      .select('id, full_name, phone, email, marketing_consent');
    setSaving(false);
    if (dbErr) {
      console.error('[settings] saving the profile failed', dbErr);
      // customers_restaurant_phone_uidx: one profile per phone number per restaurant, so the
      // number already belongs to another profile here (often a walk-in order under that phone).
      // Retrying cannot help; say which field to change.
      const phoneTaken = dbErr.code === '23505' && dbErr.message.includes('customers_restaurant_phone_uidx');
      setError(phoneTaken ? 'settings.phoneTaken' : settingsErrorKey(dbErr.message));
      return;
    }
    const row = data?.[0];
    if (!row) {
      setError('settings.saveFailed');
      return;
    }
    // Round-trip what the database actually stored, so the form can never show
    // a value that wasn't persisted.
    setFullName(row.full_name ?? '');
    setPhone(row.phone ?? '');
    setEmail(row.email ?? '');
    setMarketing(!!row.marketing_consent);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="container max-w-2xl pb-24 pt-4">
      <AccountHeader base={base} title={t('sections.settings')} />
      {loading ? null : !user ? (
        <SignInGate base={base} message={t('settings.signInPrompt')} />
      ) : (
        <form className="space-y-5" onSubmit={save}>
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <User className="h-5 w-5 text-primary" /> {t('settings.profileTitle')}
            </h2>
            <div className="mt-3 space-y-3">
              <Field label={t('settings.fullName')}>
                <input
                  className="input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('settings.fullNamePlaceholder')}
                  autoComplete="name"
                />
              </Field>
              <Field label={t('settings.phone')}>
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
              <Field label={t('settings.email')}>
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
              <Bell className="h-5 w-5 text-primary" /> {t('settings.notificationsTitle')}
            </h2>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{t('settings.promotions')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.promotionsHint')}</p>
              </div>
              <Toggle on={marketing} onClick={() => setMarketing((m) => !m)} label={t('settings.promotions')} />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">{t('settings.appearanceTitle')}</h2>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                {mode === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                {mode === 'dark' ? t('settings.darkMode') : t('settings.lightMode')}
              </span>
              <Toggle on={mode === 'dark'} onClick={toggleMode} label={t('settings.darkMode')} />
            </div>
          </Card>

          {error && (
            <Card className="border-danger/30 bg-danger/5 p-4 text-sm text-danger">{t(error)}</Card>
          )}

          {!loadingData && !customerId && (
            <Card className="border-warning/30 bg-warning/5 p-4 text-sm text-muted-foreground">
              {t('settings.noProfile')}
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
            {saved ? t('settings.saved') : t('settings.saveChanges')}
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
