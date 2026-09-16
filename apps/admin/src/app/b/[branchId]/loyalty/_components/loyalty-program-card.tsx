'use client';

// The whole programme in the merchant's hands: how points are earned, how far each badge is, what
// each badge is called, and what it promises. All four used to be fixed — a restaurant whose
// average ticket is small could not reach Silver in any realistic number of orders, and a Thai
// restaurant could set the points for a rung it could not name.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Save, Sparkles } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_TIER_PERKS } from '@favornoms/database/queries';

const TIER_KEYS = ['bronze', 'silver', 'gold', 'platinum'] as const;
type TierKey = (typeof TIER_KEYS)[number];

/** The platform's name for each rung — the placeholder, and what an emptied box falls back to. */
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

export interface LoyaltyProgramValues {
  /** The version this editor loaded; the save is refused if the stored programme has moved on. */
  version: string;
  pointsPerCurrency: number;
  silver: number;
  gold: number;
  platinum: number;
  labels: Record<string, string>;
  /** null for a tier the merchant has never written, which still shows the platform's line. */
  perks: Record<string, string[] | null>;
}

/** What an order of this size earns, so the rate is not an abstract number. */
function exampleEarn(rate: number, spend: number): number {
  return Math.floor(spend * rate);
}

/** The stock copy for a tier, as the one block of text the textarea starts from. */
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
function describeSaveError(message: string): string {
  if (message === 'not_authorized') return 'Only the restaurant owner can change the loyalty programme.';
  if (message === 'stale_settings')
    return 'The programme was changed somewhere else (another tab, device or person) after this page opened. Nothing was saved — reload the page to see the latest version, then make your change again.';
  if (message.startsWith('bad_rate')) return 'Points per $1 must be between 0.01 and 100.';
  if (message.startsWith('bad_tiers'))
    return `Tiers must climb, and each must be between 1 and ${MAX_THRESHOLD.toLocaleString()} points.`;
  if (message.startsWith('label_too_long')) return `A tier name can be at most ${MAX_LABEL} characters.`;
  if (message.startsWith('too_many_perks')) return `A tier can list at most ${MAX_PERKS} benefits.`;
  if (message.startsWith('perk_too_long') || message.startsWith('bad_perk'))
    return `Each benefit must be a line of text of at most ${MAX_PERK_LENGTH} characters.`;
  return 'The programme could not be saved. Please try again.';
}

function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function LoyaltyProgramCard({
  restaurantId,
  initial,
}: {
  restaurantId: string;
  initial: LoyaltyProgramValues;
}) {
  const router = useRouter();
  const [version, setVersion] = React.useState(initial.version);
  const [rate, setRate] = React.useState(String(initial.pointsPerCurrency));
  const [silver, setSilver] = React.useState(String(initial.silver));
  const [gold, setGold] = React.useState(String(initial.gold));
  const [platinum, setPlatinum] = React.useState(String(initial.platinum));
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

  const thresholdOf: Record<TierKey, number> = { bronze: 0, silver: s, gold: g, platinum: p };

  // The same rules the database enforces, so a merchant is told before the round trip.
  const wordProblem = TIER_KEYS.reduce<string | null>((found, k) => {
    if (found) return found;
    if (labels[k].trim().length > MAX_LABEL) return `A tier name can be at most ${MAX_LABEL} characters.`;
    const lines = toLines(perks[k]);
    if (lines.length > MAX_PERKS) return `A tier can list at most ${MAX_PERKS} benefits.`;
    if (lines.some((l) => l.length > MAX_PERK_LENGTH))
      return `A benefit line can be at most ${MAX_PERK_LENGTH} characters.`;
    return null;
  }, null);

  const problem =
    !Number.isFinite(rateNum) || rateSent < 0.01 || rateSent > 100
      ? 'Points per $1 must be between 0.01 and 100.'
      : ![s, g, p].every((n) => Number.isFinite(n) && n >= 1)
        ? 'Each tier needs a whole number of points.'
        : ![s, g, p].every((n) => n <= MAX_THRESHOLD)
          ? `A tier can be at most ${MAX_THRESHOLD.toLocaleString()} points.`
          : !(s < g && g < p)
            ? 'Tiers must climb: Silver below Gold, Gold below Platinum.'
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
      p_restaurant_id: restaurantId,
      p_expected_version: version,
      p_points_per_currency: rateSent,
      p_silver: Math.round(s),
      p_gold: Math.round(g),
      p_platinum: Math.round(p),
      p_labels: labelPayload,
      p_perks: perkPayload,
    });
    setSaving(false);
    if (rpcErr) {
      setError(describeSaveError(rpcErr.message));
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
      labels?: Record<string, string>;
      perks?: Record<string, string[] | null>;
    };
    if (stored.version) setVersion(stored.version);
    if (stored.points_per_currency != null) setRate(String(Number(stored.points_per_currency)));
    if (stored.silver != null) setSilver(String(stored.silver));
    if (stored.gold != null) setGold(String(stored.gold));
    if (stored.platinum != null) setPlatinum(String(stored.platinum));
    if (stored.labels) setLabels(labelsFrom(stored.labels));
    if (stored.perks) setPerks(perksFrom(stored.perks));
    setSavedAt(Date.now());
    // Otherwise a back/forward visit remounts this card from the page payload captured before the
    // save, and that stale snapshot is what the next save would send.
    router.refresh();
  };

  const touch = () => setSavedAt(null);

  return (
    <Card className="mb-6 p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Sparkles className="h-5 w-5 text-primary" /> Points &amp; tiers
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        How fast customers earn, how far each badge is, and what it is called. Applies to every
        branch of this restaurant.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Points per $1 of subtotal</span>
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
            A ${'​'}20 order earns{' '}
            <strong className="text-foreground">
              {Number.isFinite(rateNum) && rateNum > 0 ? exampleEarn(rateNum, 20).toLocaleString() : '—'}
            </strong>{' '}
            points. Points are counted on the subtotal, before tax, fees and tip.
          </span>
        </label>

        <div className="grid grid-cols-3 gap-2 sm:col-span-1">
          {[
            { label: 'Silver at', value: silver, set: setSilver },
            { label: 'Gold at', value: gold, set: setGold },
            { label: 'Platinum at', value: platinum, set: setPlatinum },
          ].map((f) => (
            <label key={f.label} className="block">
              <span className="mb-1.5 block text-sm font-medium">{f.label}</span>
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
            Lifetime points earned, not the current balance — spending points never costs a badge.
            Bronze is where everyone starts.
          </span>
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="font-display text-sm font-semibold">Tier names &amp; benefits</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          What each badge is called on the customer&rsquo;s loyalty page, and what it promises — one
          benefit per line, in any language. The &ldquo;unlocked at&rdquo; line is written for you
          from the numbers above, so moving a tier can never leave the wrong figure in your text.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {TIER_KEYS.map((k) => {
            const threshold = thresholdOf[k];
            const opening =
              k === 'bronze'
                ? 'Where every member starts — no minimum spend.'
                : `Unlocked at ${(Number.isFinite(threshold) ? threshold : 0).toLocaleString()} lifetime points.`;
            return (
              <div key={k} className="rounded-2xl border border-border p-3">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    {DEFAULT_LABEL[k]} tier — name
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
                  <span className="mb-1.5 block text-sm font-medium">Benefits — one per line</span>
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
                  Always shown first: <span className="text-foreground">{opening}</span>
                  {toLines(perks[k]).length === 0 && ' — and nothing else, while this box is empty.'}
                </p>
                {perks[k].trim() === defaultPerkText(k).trim() ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Using the standard wording — it stays up to date if we improve it.
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
                    Use the standard wording
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
          Save programme
        </Button>
        {/* Cleared by touch() on the next keystroke, so this never outlives what it describes. */}
        {savedAt && !saving && (
          <span className="text-sm text-success">
            Saved ✓ — every customer&rsquo;s badge was re-checked against the new tiers
          </span>
        )}
      </div>
    </Card>
  );
}
