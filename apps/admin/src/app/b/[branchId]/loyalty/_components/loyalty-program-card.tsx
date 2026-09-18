'use client';

// The whole programme in the merchant's hands: how points are earned, how far each badge is, what
// each badge is called, what it promises, and the birthday gift. All of it used to be fixed — a
// restaurant whose average ticket is small could not reach Silver in any realistic number of
// orders, and a Thai restaurant could set the points for a rung it could not name. It belongs to
// ONE branch: another branch of the same restaurant runs its own programme, and saving here
// re-grades only this branch's members.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Save, Sparkles } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_TIER_PERKS } from '@favornoms/database/queries';

const TIER_KEYS = ['bronze', 'silver', 'gold', 'platinum'] as const;
type TierKey = (typeof TIER_KEYS)[number];

/**
 * The platform's name for each rung — the placeholder, and what an emptied box falls back to.
 * Stored and compared: it stays English whatever the interface language, because it is the name
 * a diner sees until the merchant writes their own.
 */
const DEFAULT_LABEL: Record<TierKey, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
};

const MAX_LABEL = 24;
const MAX_PERKS = 6;
const MAX_PERK_LENGTH = 200;
/** The database refuses a threshold of more than nine digits (it would not fit the column). */
const MAX_THRESHOLD = 999_999_999;
/** set_loyalty_settings refuses a birthday gift above this. */
const MAX_BIRTHDAY_POINTS = 1_000_000;

type LoyaltyT = ReturnType<typeof useTranslations>;

export interface LoyaltyProgramValues {
  /** The version this editor loaded; the save is refused if the stored programme has moved on. */
  version: string;
  pointsPerCurrency: number;
  silver: number;
  gold: number;
  platinum: number;
  /** Points a member gets at this branch on their birthday; 0 means no gift. */
  birthdayPoints: number;
  labels: Record<string, string>;
  /** null for a tier the merchant has never written, which still shows the platform's line. */
  perks: Record<string, string[] | null>;
}

/** What an order of this size earns, so the rate is not an abstract number. */
function exampleEarn(rate: number, spend: number): number {
  return Math.floor(spend * rate);
}

/** A whole amount in the branch's currency ("$1", "THB 20"), for the rate's wording. */
function wholeMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // An unknown code in branches.settings must not take the whole editor down.
    return `${currency} ${amount}`;
  }
}

/**
 * The stock copy for a tier, as the one block of text the textarea starts from. English on
 * purpose: it is compared with what the merchant leaves in the box to decide whether to save it,
 * and the storefront shows diners its translation in their own language.
 */
function defaultPerkText(key: TierKey): string {
  return (DEFAULT_TIER_PERKS[key] ?? []).join('\n');
}

/** Name state: blank while the rung still carries the platform's name, so the placeholder shows it. */
function labelsFrom(source: Record<string, string>): Record<TierKey, string> {
  return Object.fromEntries(
    TIER_KEYS.map((k) => [k, source[k] === DEFAULT_LABEL[k] ? '' : (source[k] ?? '')]),
  ) as Record<TierKey, string>;
}

/** Benefit state: the text a diner reads now — the merchant's lines, or the platform's. */
function perksFrom(source: Record<string, string[] | null>): Record<TierKey, string> {
  return Object.fromEntries(
    TIER_KEYS.map((k) => [k, (source[k] ?? DEFAULT_TIER_PERKS[k] ?? []).join('\n')]),
  ) as Record<TierKey, string>;
}

/**
 * The database's refusal codes, as sentences. The form checks the same rules first, so these are
 * reached only when something slipped past it — and a merchant should never read "bad_tiers:…".
 */
function describeSaveError(message: string, t: LoyaltyT, unit: string): string {
  if (message === 'not_authorized') return t('program.errors.notAuthorized');
  if (message === 'stale_settings') return t('program.errors.stale');
  if (message.startsWith('bad_rate')) return t('program.errors.badRate', { unit });
  if (message.startsWith('bad_birthday_points'))
    return t('program.errors.badBirthday', { max: MAX_BIRTHDAY_POINTS });
  if (message.startsWith('bad_tiers')) return t('program.errors.badTiers', { max: MAX_THRESHOLD });
  if (message.startsWith('label_too_long')) return t('program.errors.labelTooLong', { max: MAX_LABEL });
  if (message.startsWith('too_many_perks')) return t('program.errors.tooManyPerks', { max: MAX_PERKS });
  if (message.startsWith('perk_too_long') || message.startsWith('bad_perk'))
    return t('program.errors.perkInvalid', { max: MAX_PERK_LENGTH });
  console.error('set_loyalty_settings failed', message);
  return t('program.errors.saveFailed');
}

function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function LoyaltyProgramCard({
  branchId,
  currency,
  initial,
}: {
  branchId: string;
  /** branches.settings.currency — the rate is "points per 1 of this". */
  currency: string;
  initial: LoyaltyProgramValues;
}) {
  const t = useTranslations('loyalty');
  const locale = useLocale();
  const router = useRouter();
  const unit = wholeMoney(1, currency);
  const [version, setVersion] = React.useState(initial.version);
  const [rate, setRate] = React.useState(String(initial.pointsPerCurrency));
  const [silver, setSilver] = React.useState(String(initial.silver));
  const [gold, setGold] = React.useState(String(initial.gold));
  const [platinum, setPlatinum] = React.useState(String(initial.platinum));
  const [birthday, setBirthday] = React.useState(String(initial.birthdayPoints));
  // Names start blank when they are still the platform's, so the placeholder shows what a diner
  // sees today and clearing the box visibly means "go back to that".
  const [labels, setLabels] = React.useState<Record<TierKey, string>>(() => labelsFrom(initial.labels));
  // Benefits start as the text a diner reads right now — the merchant's own if they have written
  // any, otherwise the platform's, which they can edit in place or delete outright.
  const [perks, setPerks] = React.useState<Record<TierKey, string>>(() => perksFrom(initial.perks));
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const rateNum = Number(rate);
  // What the server will receive. A rate like 0.004 looks positive but rounds to 0, so the check
  // has to be on this, not on what was typed.
  const rateSent = Math.round(rateNum * 100) / 100;
  const s = Number(silver);
  const g = Number(gold);
  const p = Number(platinum);
  const b = Number(birthday);

  const thresholdOf: Record<TierKey, number> = { bronze: 0, silver: s, gold: g, platinum: p };

  // The same rules the database enforces, so a merchant is told before the round trip.
  const wordProblem = TIER_KEYS.reduce<string | null>((found, k) => {
    if (found) return found;
    if (labels[k].trim().length > MAX_LABEL) return t('program.errors.labelTooLong', { max: MAX_LABEL });
    const lines = toLines(perks[k]);
    if (lines.length > MAX_PERKS) return t('program.errors.tooManyPerks', { max: MAX_PERKS });
    if (lines.some((l) => l.length > MAX_PERK_LENGTH))
      return t('program.errors.perkLineTooLong', { max: MAX_PERK_LENGTH });
    return null;
  }, null);

  const problem =
    !Number.isFinite(rateNum) || rateSent < 0.01 || rateSent > 100
      ? t('program.errors.badRate', { unit })
      : ![s, g, p].every((n) => Number.isFinite(n) && n >= 1)
        ? t('program.errors.wholeNumber')
        : ![s, g, p].every((n) => n <= MAX_THRESHOLD)
          ? t('program.errors.thresholdTooHigh', { max: MAX_THRESHOLD })
          : !(s < g && g < p)
            ? t('program.errors.mustClimb')
            : birthday === '' || !Number.isInteger(b) || b < 0 || b > MAX_BIRTHDAY_POINTS
              ? t('program.errors.badBirthday', { max: MAX_BIRTHDAY_POINTS })
              : wordProblem;

  const save = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);

    // Both objects carry the FULL desired state: the function replaces what it is given, so a key
    // left out goes back to the platform's wording rather than keeping a stale override. A name or
    // a benefit block still identical to the platform's is left out deliberately — it stays a
    // default that follows the platform instead of freezing today's text into this restaurant.
    const labelPayload: Record<string, string> = {};
    const perkPayload: Record<string, string[]> = {};
    for (const k of TIER_KEYS) {
      const name = labels[k].trim();
      if (name && name !== DEFAULT_LABEL[k]) labelPayload[k] = name;
      if (perks[k].trim() !== defaultPerkText(k).trim()) perkPayload[k] = toLines(perks[k]);
    }

    const supabase = getBrowserClient();
    const { data: saved, error: rpcErr } = await supabase.rpc('set_loyalty_settings', {
      p_branch_id: branchId,
      p_expected_version: version,
      p_points_per_currency: rateSent,
      p_silver: Math.round(s),
      p_gold: Math.round(g),
      p_platinum: Math.round(p),
      p_labels: labelPayload,
      p_perks: perkPayload,
      p_birthday_points: Math.round(b),
    });
    setSaving(false);
    if (rpcErr) {
      setError(describeSaveError(rpcErr.message, t, unit));
      return;
    }
    // Re-seed from what was stored, with the version it now has: the next save must be checked
    // against THIS write, and the form must show what the server kept (blank lines dropped, names
    // trimmed), not what was typed.
    const stored = (saved ?? {}) as {
      version?: string;
      points_per_currency?: number | string;
      silver?: number;
      gold?: number;
      platinum?: number;
      birthday_points?: number;
      labels?: Record<string, string>;
      perks?: Record<string, string[] | null>;
    };
    if (stored.version) setVersion(stored.version);
    if (stored.points_per_currency != null) setRate(String(Number(stored.points_per_currency)));
    if (stored.silver != null) setSilver(String(stored.silver));
    if (stored.gold != null) setGold(String(stored.gold));
    if (stored.platinum != null) setPlatinum(String(stored.platinum));
    if (stored.birthday_points != null) setBirthday(String(stored.birthday_points));
    if (stored.labels) setLabels(labelsFrom(stored.labels));
    if (stored.perks) setPerks(perksFrom(stored.perks));
    setSavedAt(Date.now());
    // Otherwise a back/forward visit remounts this card from the page payload captured before the
    // save, and that stale snapshot is what the next save would send.
    router.refresh();
  };

  const touch = () => setSavedAt(null);

  const example = Number.isFinite(rateNum) && rateNum > 0 ? exampleEarn(rateNum, 20) : null;
  const strong = (chunks: React.ReactNode) => <strong className="text-foreground">{chunks}</strong>;

  return (
    <Card className="mb-6 p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Sparkles className="h-5 w-5 text-primary" /> {t('program.title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('program.description')}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('program.rateLabel', { unit })}</span>
          <input
            value={rate}
            onChange={(e) => {
              setRate(e.target.value.replace(/[^0-9.]/g, ''));
              touch();
            }}
            inputMode="decimal"
            className="input"
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {example !== null
              ? t.rich('program.rateExample', {
                  count: example,
                  amount: wholeMoney(20, currency),
                  strong,
                })
              : t.rich('program.rateExampleEmpty', { amount: wholeMoney(20, currency), strong })}{' '}
            {t('program.rateBasis')}
          </span>
        </label>

        <div className="grid grid-cols-3 gap-2 sm:col-span-1">
          {[
            { key: 'silver' as const, value: silver, set: setSilver },
            { key: 'gold' as const, value: gold, set: setGold },
            { key: 'platinum' as const, value: platinum, set: setPlatinum },
          ].map((f) => (
            <label key={f.key} className="block">
              <span className="mb-1.5 block text-sm font-medium">{t(`program.thresholdLabel.${f.key}`)}</span>
              <input
                value={f.value}
                onChange={(e) => {
                  f.set(e.target.value.replace(/\D/g, ''));
                  touch();
                }}
                inputMode="numeric"
                maxLength={9}
                className="input"
              />
            </label>
          ))}
          <span className="col-span-3 block text-xs text-muted-foreground">
            {t('program.thresholdHint')}
          </span>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('program.birthdayLabel')}</span>
          <input
            value={birthday}
            onChange={(e) => {
              setBirthday(e.target.value.replace(/\D/g, ''));
              touch();
            }}
            inputMode="numeric"
            maxLength={7}
            className="input"
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {t('program.birthdayHint')}
          </span>
        </label>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="font-display text-sm font-semibold">{t('program.wordsTitle')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('program.wordsBody')}</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {TIER_KEYS.map((k) => {
            const threshold = thresholdOf[k];
            const opening =
              k === 'bronze'
                ? t('program.starter')
                : t('program.unlockedAt', { points: Number.isFinite(threshold) ? threshold : 0 });
            const usingStandard = perks[k].trim() === defaultPerkText(k).trim();
            const line = (chunks: React.ReactNode) => <span className="text-foreground">{chunks}</span>;
            return (
              <div key={k} className="rounded-2xl border border-border p-3">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    {t(`program.tierNameLabel.${k}`)}
                  </span>
                  <input
                    value={labels[k]}
                    onChange={(e) => {
                      setLabels((prev) => ({ ...prev, [k]: e.target.value }));
                      touch();
                    }}
                    maxLength={MAX_LABEL}
                    placeholder={DEFAULT_LABEL[k]}
                    className="input"
                  />
                </label>
                <label className="mt-3 block">
                  <span className="mb-1.5 block text-sm font-medium">{t('program.benefitsLabel')}</span>
                  <textarea
                    value={perks[k]}
                    onChange={(e) => {
                      setPerks((prev) => ({ ...prev, [k]: e.target.value }));
                      touch();
                    }}
                    rows={3}
                    className="input min-h-[4.5rem] resize-y"
                  />
                </label>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {toLines(perks[k]).length === 0
                    ? t.rich('program.alwaysFirstOnly', { opening, line })
                    : t.rich('program.alwaysFirst', { opening, line })}
                </p>
                {usingStandard ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('program.standardWording')}
                    {locale !== 'en' && <> {t('program.standardWordingTranslated')}</>}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setPerks((prev) => ({ ...prev, [k]: defaultPerkText(k) }));
                      touch();
                    }}
                    className="focus-ring mt-1 rounded text-xs font-medium text-primary underline underline-offset-2"
                  >
                    {t('program.useStandard')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {problem && !error && <p className="mt-3 text-xs text-warning">{problem}</p>}
      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!!problem} leftIcon={<Save className="h-4 w-4" />}>
          {t('program.save')}
        </Button>
        {/* Cleared by touch() on the next keystroke, so this never outlives what it describes. */}
        {savedAt && !saving && (
          <span className="text-sm text-success">{t('program.saved')}</span>
        )}
      </div>
    </Card>
  );
}
