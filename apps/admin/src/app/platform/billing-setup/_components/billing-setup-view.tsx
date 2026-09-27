'use client';

// The platform owner's Stripe page. Every decision is in setup-model.ts; this file reads
// the status from the stripe-billing function, renders what the model says, and moves the
// one switch.
//
// The status is read in the browser on purpose (see page.tsx): the checklist and the
// webhook instructions must be on screen even when that read fails, because they are what
// makes it succeed.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  HelpCircle,
  MinusCircle,
  RefreshCw,
  Wand2,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  getStripeBillingStatus,
  setStripeBillingEnabled,
  type PlatformBillingEvent,
  type StripeBillingStatus,
} from '@favornoms/database/queries';
import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '@favornoms/shared';
import { Badge, Button, Card, cn, copyText, useConfirm } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';
import {
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENTS,
  eventLabelKey,
  eventTone,
  fmtDateTimeUtc,
  setEnabledErrorKey,
  setupSteps,
  statusLoadErrorKey,
  switchModel,
  usefulLinks,
  type SetupLink,
  type SetupMsg,
  type SetupStep,
  type StepState,
} from './setup-model';

type T = ReturnType<typeof useTranslations<'platformBilling'>>;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: StripeBillingStatus; refreshing?: boolean }
  /** The function answered 503 stripe_not_configured. */
  | { kind: 'dormant'; refreshing?: boolean }
  | { kind: 'error'; key: string; refreshing?: boolean };

const STATE_ICON: Record<StepState, React.ComponentType<{ className?: string }>> = {
  done: CheckCircle2,
  todo: AlertCircle,
  auto: Wand2,
  notNeeded: MinusCircle,
  manual: Eye,
  unknown: HelpCircle,
};

const STATE_CLS: Record<StepState, string> = {
  done: 'text-success',
  todo: 'text-warning',
  auto: 'text-muted-foreground',
  notNeeded: 'text-muted-foreground',
  manual: 'text-info',
  unknown: 'text-muted-foreground',
};

const STATE_BADGE: Record<StepState, 'success' | 'warning' | 'muted' | 'info'> = {
  done: 'success',
  todo: 'warning',
  auto: 'muted',
  notNeeded: 'muted',
  manual: 'info',
  unknown: 'muted',
};

function useUiLocale(): UiLocale {
  const raw = useLocale();
  return isUiLocale(raw) ? raw : DEFAULT_UI_LOCALE;
}

const say = (t: T, m: SetupMsg): string => (m.values ? t(m.key, m.values) : t(m.key));

export function BillingSetupView({
  events,
  restaurantNames,
  webhookUrl,
  secretsUrl,
}: {
  events: PlatformBillingEvent[];
  restaurantNames: Record<string, string>;
  webhookUrl: string;
  secretsUrl: string;
}) {
  const t = useTranslations('platformBilling');
  const locale = useUiLocale();
  const router = useRouter();
  const confirm = useConfirm();
  const [load, setLoad] = React.useState<LoadState>({ kind: 'loading' });
  const [switching, setSwitching] = React.useState(false);
  const [switchError, setSwitchError] = React.useState<string | null>(null);

  const readStatus = React.useCallback(async () => {
    // A refresh keeps what is on screen until the answer lands, so the page does not
    // flash back to "asking Stripe" every time.
    setLoad((prev) => (prev.kind === 'loading' ? prev : { ...prev, refreshing: true }));
    try {
      const status = await getStripeBillingStatus(getBrowserClient());
      setLoad(status ? { kind: 'ready', status } : { kind: 'dormant' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The code is for the log; the owner gets a sentence.
      console.error('[platform/billing-setup] status failed:', message);
      setLoad({ kind: 'error', key: statusLoadErrorKey(message) });
    }
  }, []);

  React.useEffect(() => {
    void readStatus();
  }, [readStatus]);

  const status = load.kind === 'ready' ? load.status : null;
  const steps = setupSteps(status, { secretsUrl, locale });
  const sw = switchModel(status);
  const refreshing = load.kind !== 'loading' && load.refreshing === true;

  const toggle = async () => {
    if (!status || switching) return;
    const turnOn = !status.stripeEnabled;
    if (turnOn ? !sw.canTurnOn : !sw.canTurnOff) return;
    const ok = await confirm(
      turnOn
        ? {
            title: t('stripe.setup.switch.confirmOnTitle'),
            body:
              status.mode === 'test'
                ? t('stripe.setup.switch.confirmOnBodyTest')
                : t('stripe.setup.switch.confirmOnBodyLive'),
            confirmLabel: t('stripe.setup.switch.confirmOn'),
          }
        : {
            title: t('stripe.setup.switch.confirmOffTitle'),
            body: t('stripe.setup.switch.confirmOffBody'),
            confirmLabel: t('stripe.setup.switch.confirmOff'),
            destructive: true,
          },
    );
    if (!ok) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      const next = await setStripeBillingEnabled(getBrowserClient(), turnOn);
      if (next) {
        setLoad({ kind: 'ready', status: next });
      } else {
        // The function went dormant between the read and the write: nothing was changed.
        setLoad({ kind: 'dormant' });
        setSwitchError(t('stripe.setup.switch.errors.dormant'));
      }
      // The event log and the Requests badge are server-rendered.
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[platform/billing-setup] set_enabled failed:', message);
      setSwitchError(t(setEnabledErrorKey(message)));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('stripe.setup.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('stripe.setup.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {status && <ModeBadge mode={status.mode} t={t} />}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void readStatus()}
            loading={load.kind === 'loading' || refreshing}
            leftIcon={<RefreshCw className="h-4 w-4" />}
          >
            {t('stripe.setup.load.refresh')}
          </Button>
        </div>
      </header>
      <PlatformNav />

      <LoadBanner load={load} t={t} />

      <SwitchCard
        status={status}
        model={sw}
        switching={switching}
        error={switchError}
        onToggle={() => void toggle()}
        t={t}
      />

      <Card className="mb-6 p-5">
        <h2 className="font-display text-lg font-semibold">{t('stripe.setup.stepsTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('stripe.setup.stepsIntro')}</p>
        <ol className="mt-4 divide-y divide-border">
          {steps.map((step) => (
            <StepItem key={step.id} step={step} webhookUrl={webhookUrl} t={t} />
          ))}
        </ol>
      </Card>

      <Card className="mb-6 p-5">
        <h2 className="font-display text-lg font-semibold">{t('stripe.setup.linksTitle')}</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {usefulLinks(status).map((link) => (
            <ExternalButton key={link.key} link={link} t={t} />
          ))}
        </div>
      </Card>

      <EventsCard events={events} restaurantNames={restaurantNames} locale={locale} t={t} />
    </div>
  );
}

function ModeBadge({ mode, t }: { mode: StripeBillingStatus['mode']; t: T }) {
  if (mode === 'live') return <Badge variant="success">{t('stripe.setup.mode.live')}</Badge>;
  if (mode === 'test') return <Badge variant="warning">{t('stripe.setup.mode.test')}</Badge>;
  return <Badge variant="muted">{t('stripe.setup.mode.unknown')}</Badge>;
}

function LoadBanner({ load, t }: { load: LoadState; t: T }) {
  if (load.kind === 'ready') return null;
  if (load.kind === 'loading') {
    return (
      <p role="status" className="mb-4 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
        {t('stripe.setup.load.loading')}
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{load.kind === 'dormant' ? t('stripe.setup.load.dormant') : t(load.key)}</span>
    </div>
  );
}

function SwitchCard({
  status,
  model,
  switching,
  error,
  onToggle,
  t,
}: {
  status: StripeBillingStatus | null;
  model: ReturnType<typeof switchModel>;
  switching: boolean;
  error: string | null;
  onToggle: () => void;
  t: T;
}) {
  const on = model.on === true;
  const enabled = !switching && (on ? model.canTurnOff : model.canTurnOn);
  const labelId = React.useId();
  return (
    <Card className={cn('mb-6 p-5', on && 'border-primary')}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 id={labelId} className="flex items-center gap-2 font-display text-lg font-semibold">
            <CreditCard className="h-5 w-5 text-primary" aria-hidden />
            {t('stripe.setup.switch.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {model.on === null
              ? t('stripe.setup.switch.unknownBody')
              : on
                ? t('stripe.setup.switch.onBody')
                : t('stripe.setup.switch.offBody')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">
            {switching
              ? t('stripe.setup.switch.saving')
              : model.on === null
                ? '—'
                : on
                  ? t('stripe.setup.switch.on')
                  : t('stripe.setup.switch.off')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby={labelId}
            disabled={!enabled}
            onClick={onToggle}
            className={cn(
              'focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              on ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                on ? 'translate-x-6' : 'translate-x-1',
              )}
            />
          </button>
        </div>
      </div>

      {!on && model.blockers.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {model.blockers.map((b) => (
            <li key={b.key} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              {say(t, b)}
            </li>
          ))}
        </ul>
      )}

      {!on && status && model.warnings.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {model.warnings.map((w) => (
            <li key={w.key} className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              {say(t, w)}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}

function StepItem({ step, webhookUrl, t }: { step: SetupStep; webhookUrl: string; t: T }) {
  const Icon = STATE_ICON[step.state];
  return (
    <li className="flex gap-3 py-4 first:pt-0 last:pb-0">
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', STATE_CLS[step.state])} aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{t(`stripe.setup.steps.${step.id}.title`)}</h3>
          <Badge variant={STATE_BADGE[step.state]} className="px-2 py-0.5 text-[10px]">
            {t(`stripe.setup.state.${step.state}`)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t(`stripe.setup.steps.${step.id}.body`)}</p>
        {step.detail && <p className="text-sm font-medium">{say(t, step.detail)}</p>}
        {step.id === 'webhook' && <WebhookHow url={webhookUrl} t={t} />}
        {step.links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {step.links.map((link) => (
              <ExternalButton key={link.key} link={link} t={t} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Exactly what to click in Stripe, with the two values to paste. Shown whatever the
 * webhook's state: a done webhook is the one most likely to be recreated (new mode, a
 * rotated secret), and the owner then needs the same list again.
 */
function WebhookHow({ url, t }: { url: string; t: T }) {
  const code = (chunks: React.ReactNode) => <code className="font-mono text-xs">{chunks}</code>;
  return (
    <div className="space-y-3 rounded-xl bg-muted/50 p-3 text-sm">
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>{t('stripe.setup.webhook.how1')}</li>
        <li>{t.rich('stripe.setup.webhook.how2', { version: WEBHOOK_API_VERSION, code })}</li>
        <li>{t('stripe.setup.webhook.how3', { count: WEBHOOK_EVENTS.length })}</li>
        <li>{t('stripe.setup.webhook.how4')}</li>
        <li>{t.rich('stripe.setup.webhook.how5', { code })}</li>
      </ol>

      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">{t('stripe.setup.webhook.endpoint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all rounded-lg bg-background px-2 py-1.5 font-mono text-xs">{url}</code>
          <CopyButton text={url} t={t} />
        </div>
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t('stripe.setup.webhook.events', { count: WEBHOOK_EVENTS.length })}
          </p>
          <CopyButton text={WEBHOOK_EVENTS.join('\n')} t={t} all />
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {WEBHOOK_EVENTS.map((e) => (
            <li key={e}>
              <code className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[11px]">{e}</code>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">{t('stripe.setup.webhook.notConnect')}</p>
    </div>
  );
}

function CopyButton({ text, t, all = false }: { text: string; t: T; all?: boolean }) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => void copy()}
      leftIcon={state === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    >
      <span role="status">
        {state === 'copied'
          ? t('stripe.setup.copy.copied')
          : state === 'failed'
            ? t('stripe.setup.copy.failed')
            : all
              ? t('stripe.setup.copy.copyAll')
              : t('stripe.setup.copy.copy')}
      </span>
    </Button>
  );
}

function ExternalButton({ link, t }: { link: SetupLink; t: T }) {
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      {t(`stripe.setup.links.${link.key}`)}
    </a>
  );
}

function EventsCard({
  events,
  restaurantNames,
  locale,
  t,
}: {
  events: PlatformBillingEvent[];
  restaurantNames: Record<string, string>;
  locale: UiLocale;
  t: T;
}) {
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">{t('stripe.setup.events.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('stripe.setup.events.subtitle')}</p>
      {events.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('stripe.setup.events.empty')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border text-sm">
          {events.map((e) => {
            const labelKey = eventLabelKey(e.type);
            const tone = eventTone(e.level);
            const restaurant = e.restaurantId ? (restaurantNames[e.restaurantId] ?? null) : null;
            return (
              <li key={e.id} className="grid gap-1 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {fmtDateTimeUtc(e.createdAt, locale)}
                </span>
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{labelKey ? t(labelKey) : e.type}</span>
                    {tone !== 'muted' && (
                      <Badge variant={tone} className="px-2 py-0.5 text-[10px]">
                        {t(`stripe.setup.events.level.${tone === 'danger' ? 'error' : 'warn'}`)}
                      </Badge>
                    )}
                    {restaurant && <span className="text-muted-foreground">· {restaurant}</span>}
                  </p>
                  {/* The raw type stays visible: it is what Stripe's own log searches by. */}
                  {labelKey && <p className="font-mono text-[11px] text-muted-foreground">{e.type}</p>}
                  {e.note && <p className="break-words text-xs text-muted-foreground">{e.note}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
