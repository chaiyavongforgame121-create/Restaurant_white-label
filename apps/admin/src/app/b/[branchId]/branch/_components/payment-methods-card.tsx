'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Lock, Save, Wallet } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';
import { ImageUpload } from '@/components/image-upload';

// Editor for the payment_methods key inside branches.settings (jsonb).
// Saves independently from the main BranchSettings form — merges keys, never
// clobbers unrelated settings. Absent key/subkey means ENABLED, so existing
// branches keep accepting everything until staff opt out.
//
// Card is additionally gated on the card_payment entitlement. Without it the
// toggles are locked OFF and read-only: the branches.settings write itself is
// ungated (it is the merchant's own row), so leaving the switch live would let
// a restaurant advertise a payment method that place-order then refuses with a
// 403 at checkout — the worst possible place to discover it.
//
// Scope: DELIVERY and PICKUP only. Dine-in checkout has no payment step at all
// (the diner settles at the restaurant), and place-order exempts dine-in from
// this matrix — so nothing here can block a dine-in order.

interface Props {
  branchId: string;
  restaurantId: string;
  settings: Record<string, unknown>;
  canUseCard: boolean;
}

/** branches.settings.qr_transfer — the merchant's own bank/QR details, shown to the
 *  diner at checkout. Not secret: the whole point is that customers scan it. */
interface QrTransfer {
  image_url: string | null;
  account_name: string;
  instructions: string;
}

type Mode = 'asap' | 'scheduled';
type Method = 'cash' | 'card' | 'transfer';

// Labels live in the branchOps catalogue under payments.modes.<key> / payments.methods.<key>.
const MODES: Array<{ key: Mode }> = [{ key: 'asap' }, { key: 'scheduled' }];

const METHODS: Array<{ key: Method }> = [{ key: 'cash' }, { key: 'card' }, { key: 'transfer' }];

type PaymentMatrix = Record<Mode, Record<Method, boolean>>;

/** Raw database text never reaches the merchant: a known refusal gets its own message,
 *  anything else the generic one. */
function saveErrorKey(err: { message: string; code?: string }): string {
  if (err.code === '42501' || err.message === 'forbidden' || err.message.includes('branch_manager_required')) {
    return 'errors.noPermission';
  }
  return 'errors.generic';
}

function seedFromSettings(settings: Record<string, unknown>): PaymentMatrix {
  const raw = settings?.payment_methods as
    | Partial<Record<Mode, Partial<Record<Method, unknown>>>>
    | undefined;
  const read = (mode: Mode, method: Method) => {
    const v = raw?.[mode]?.[method];
    return typeof v === 'boolean' ? v : true;
  };
  // Transfer defaults to OFF for every existing branch. Every other method defaults to
  // ON for backward compatibility, but a merchant who has never seen this feature must
  // not silently start accepting bank transfers they are not watching for.
  const readTransfer = (mode: Mode) => raw?.[mode]?.transfer === true;
  return {
    asap: { cash: read('asap', 'cash'), card: read('asap', 'card'), transfer: readTransfer('asap') },
    scheduled: {
      cash: read('scheduled', 'cash'),
      card: read('scheduled', 'card'),
      transfer: readTransfer('scheduled'),
    },
  };
}

function seedQr(settings: Record<string, unknown>): QrTransfer {
  const raw = settings?.qr_transfer as Partial<QrTransfer> | undefined;
  return {
    image_url: typeof raw?.image_url === 'string' && raw.image_url ? raw.image_url : null,
    account_name: typeof raw?.account_name === 'string' ? raw.account_name : '',
    instructions: typeof raw?.instructions === 'string' ? raw.instructions : '',
  };
}

export function PaymentMethodsCard({ branchId, restaurantId, settings, canUseCard }: Props) {
  const t = useTranslations('branchOps');
  const router = useRouter();
  const [matrix, setMatrix] = React.useState<PaymentMatrix>(() => {
    const seeded = seedFromSettings(settings);
    if (canUseCard) return seeded;
    return {
      asap: { ...seeded.asap, card: false },
      scheduled: { ...seeded.scheduled, card: false },
    };
  });
  const [qr, setQr] = React.useState<QrTransfer>(() => seedQr(settings));
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // With card locked off, "no method enabled" would fire for every branch that
  // has cash off — which is the real warning, so it still applies. The copy names
  // delivery and pickup explicitly: a dine-in-only restaurant is unaffected, and
  // telling it that "customers can't order" would be plain wrong.
  const deadModes = MODES.filter(
    (m) => !matrix[m.key].cash && !matrix[m.key].card && !matrix[m.key].transfer,
  );
  // Mirrors place-order's `transfer_not_configured` guard: without a QR there is
  // nothing for the diner to scan, so the toggle cannot be armed.
  const canUseTransfer = !!qr.image_url;
  const transferOn = matrix.asap.transfer || matrix.scheduled.transfer;

  const toggle = (mode: Mode, method: Method) => {
    if (method === 'card' && !canUseCard) return;
    if (method === 'transfer' && !canUseTransfer) return;
    setMatrix((v) => ({ ...v, [mode]: { ...v[mode], [method]: !v[mode][method] } }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    // Merge into the existing jsonb — other settings keys stay untouched.
    const { error: updateError } = await supabase
      .from('branches')
      .update({ settings: { ...settings, payment_methods: matrix, qr_transfer: qr } })
      .eq('id', branchId);
    setSaving(false);
    if (updateError) {
      console.error('Saving payment methods failed', updateError);
      setError(t(saveErrorKey(updateError)));
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Wallet className="h-5 w-5 text-primary" /> {t('payments.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('payments.description')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('payments.dineInNote')}</p>

      <div className="mt-4 rounded-xl border border-border p-3">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 gap-y-3">
          <span />
          {MODES.map((m) => (
            <span
              key={m.key}
              className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {t(`payments.modes.${m.key}`)}
            </span>
          ))}
          {METHODS.map((method) => {
            const locked =
              (method.key === 'card' && !canUseCard) ||
              (method.key === 'transfer' && !canUseTransfer);
            const methodLabel = t(`payments.methods.${method.key}.label`);
            return (
              <React.Fragment key={method.key}>
                <span className={locked ? 'opacity-60' : undefined}>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {methodLabel}
                    {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {locked
                      ? method.key === 'transfer'
                        ? t('payments.lockedTransfer')
                        : t('payments.lockedPackage')
                      : t(`payments.methods.${method.key}.hint`)}
                  </span>
                </span>
                {MODES.map((m) => (
                  <span key={m.key} className="text-center">
                    <input
                      type="checkbox"
                      aria-label={t('payments.toggleAria', {
                        method: methodLabel,
                        mode: t(`payments.modes.${m.key}`),
                      })}
                      checked={matrix[m.key][method.key]}
                      disabled={locked}
                      onChange={() => toggle(m.key, method.key)}
                      className="h-5 w-5 accent-primary disabled:opacity-40"
                    />
                  </span>
                ))}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {!canUseCard && (
        <p className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted px-4 py-3 text-sm">
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{t('payments.cardLocked')}</span>
          <Link
            href={`/b/${branchId}/settings/plan`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('payments.viewPackages')}
          </Link>
        </p>
      )}

      {deadModes.length > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {t('payments.noMethod', {
              which: deadModes.length > 1 ? 'both' : (deadModes[0]?.key ?? 'both'),
            })}
          </span>
        </p>
      )}

      <div className="mt-5 rounded-xl border border-border p-4">
        <h3 className="font-display text-base font-semibold">{t('payments.qr.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t.rich('payments.qr.description', {
            b: (chunks) => <span className="font-medium">{chunks}</span>,
          })}
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-[10rem_1fr]">
          <ImageUpload
            restaurantId={restaurantId}
            folder="payment-qr"
            value={qr.image_url}
            onChange={(url) => setQr((v) => ({ ...v, image_url: url }))}
            aspect="aspect-square"
            label={t('payments.qr.upload')}
          />
          <div className="space-y-3">
            <div>
              <label htmlFor="qr-account" className="text-sm font-medium">
                {t('payments.qr.accountName')}
              </label>
              <input
                id="qr-account"
                value={qr.account_name}
                onChange={(e) => setQr((v) => ({ ...v, account_name: e.target.value }))}
                maxLength={120}
                placeholder={t('payments.qr.accountNamePlaceholder')}
                className="focus-ring mt-1 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="qr-instructions" className="text-sm font-medium">
                {t('payments.qr.instructions')}
              </label>
              <textarea
                id="qr-instructions"
                value={qr.instructions}
                onChange={(e) => setQr((v) => ({ ...v, instructions: e.target.value }))}
                rows={2}
                maxLength={280}
                placeholder={t('payments.qr.instructionsPlaceholder')}
                className="focus-ring mt-1 w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
        {transferOn && !qr.image_url && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>{t('payments.qr.onWithoutImage')}</span>
          </p>
        )}
        {/* The opposite trap, and the one that actually bites: the merchant uploads their QR,
            sees it saved, and assumes that is the whole job. It is not — the method also has
            to be ticked above, and until it is the QR option simply never appears at
            checkout, with nothing on either screen explaining the silence. */}
        {!transferOn && qr.image_url && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              {t.rich('payments.qr.savedButOff', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </span>
          </p>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {t('payments.save')}
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}
