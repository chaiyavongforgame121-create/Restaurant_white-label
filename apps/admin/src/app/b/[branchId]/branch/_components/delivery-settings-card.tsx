'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Save } from 'lucide-react';
import {
  DELIVERY_SETTING_DEFAULTS,
  KM_PER_MILE,
  kmToMi,
  miToKm,
  parseDeliverySettings,
  previewDistancesMi,
  quoteDeliveryLocal,
  surgeIsUnreachable,
} from '@favornoms/shared';
import { Button, Card, RiderIcon } from '@favornoms/ui';
import { useSettingsPatch } from './patch-settings';

// Structured editor for the delivery keys inside branches.settings (jsonb).
// Saves independently from the main BranchSettings form, through patch_branch_settings, and
// sends only the keys that changed. It used to write back every key it shows, including the
// kitchen's Pause and Busy state as they were when this page loaded, so saving a fee here
// un-paused a kitchen that had paused in the meantime.
//
// "Changed" is decided on the numbers Save would write, not on the stored ones: distances and
// rates are shown in miles and $/mi rounded to 2 decimals and converted back, so an untouched
// 8 km radius comes back as 7.9984 km. Compared with the row, every converted key looked changed
// on every save and a stale tab still overwrote them. The card's own starting point is put
// through the same rounding and conversion (shownPatch) and compared with that instead.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
}

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

type NumericKey =
  | 'delivery_base_fee'
  | 'delivery_per_km_fee'
  | 'delivery_surge_from_mi'
  | 'delivery_radius_km'
  | 'prep_time_min'
  | 'driver_search_radius_km'
  | 'driver_max_attempts'
  | 'dispatch_max_gps_age_min'
  | 'offer_ttl_seconds'
  | 'batch_max_detour_mi'
  | 'driver_max_pay';

const FIELDS: Array<{
  key: NumericKey;
  /** Message key under branchOps delivery.fields.<msg> — `.label`, and `.hint` when `hint` is set. */
  msg: string;
  hint?: true;
  step?: string;
  /** 'surge' is rendered by hand next to the multiplier slider, not by the group loop. */
  group: 'fees' | 'timing' | 'dispatch' | 'pay' | 'surge';
  fallback: number;
  /**
   * Upper bound, in the DISPLAY unit (miles / dollars), enforced on the input AND clamped
   * again on save. Without it these were unbounded: production had a driver search radius of
   * 1,000,000,000 mi and 999,999,999,999,999 dispatch attempts saved on a live branch, which
   * makes find_dispatch_candidates match every driver on earth and stops staff ever being
   * alerted that dispatch failed. A typo of one extra zero must not be able to do that.
   */
  max: number;
  /** Field is shown/entered in miles ('dist') or $/mile ('rate'); stored as km / $-per-km. */
  convert?: 'dist' | 'rate';
  /**
   * Whole numbers only. Postgres reads prep_time_min, busy_extra_prep_min, offer_ttl_seconds
   * and dispatch_max_gps_age_min with an `::int` cast, and a cast does not round — it
   * RAISES. One merchant typing 15.5 for prep time makes quote_delivery throw, quoteDelivery()
   * swallows the error and returns null, and both checkout and place-order quietly fall back
   * to the legacy flat fee: distance pricing and surge stop working for that branch with
   * nothing on any screen to say why. `step="1"` on a number input does not prevent it
   * (typing, pasting and scripted changes all bypass it), so these round on save. The
   * attempt count rides along because half an attempt is meaningless too.
   */
  integer?: boolean;
}> = [
  { key: 'delivery_base_fee', msg: 'baseFee', group: 'fees', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.deliveryBaseFee, max: 100 },
  { key: 'delivery_per_km_fee', msg: 'perMile', group: 'fees', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.deliveryPerKmFee, convert: 'rate', max: 50 },
  // Was capped at 50 mi. Opened at the owner's request (2026-08-29) for long-distance
  // testing, on the same reasoning as the two dispatch fields below — with one caveat that
  // is NOT true of those, and that the hint now states: 50 mi was not an arbitrary number.
  // private.branch_driver_pay_cap defaults to $50 and its comment says so outright — "$2
  // base + $1/mi caps out at the old 50 mi radius. Deliberate." Past 50 mi the driver's pay
  // stops growing while their drive does, so `driver_max_pay` has to move with the radius.
  // The customer side is NO LONGER bounded: the minimum/maximum fee inputs were removed at
  // the owner's request (2026-08-31) and quote_delivery no longer clamps, so a long delivery
  // now charges base + per-mile in full. Rider pay still stops at driver_max_pay, which is
  // why that one stayed.
  //
  // BOUNDS (2026-09-18): the opened fields below had a max of 9,999,999,999, which only stopped
  // nothing. They now stop at values far past any real delivery that still serve the owner's
  // long-distance and dispatch testing: 500 mi of delivery radius, 12,500 mi of rider search
  // (half the Earth's circumference, so every rider on the planet is still a candidate), 1,000
  // dispatch rounds (hours of retrying), a day of GPS age and $1,000 of rider pay. A value
  // already stored above its bound is shown as stored and left alone until someone edits it.
  { key: 'delivery_radius_km', msg: 'radius', hint: true, group: 'timing', step: '0.5', fallback: DELIVERY_SETTING_DEFAULTS.deliveryRadiusKm, convert: 'dist', max: 500 },
    // group 'surge', not 'fees': this and the multiplier are one setting, and they were two
  // sections apart — the merchant read "Surge multiplier" with no distance beside it and
  // reported the distance field as missing. They now sit together.
  { key: 'delivery_surge_from_mi', msg: 'surgeFrom', hint: true, group: 'surge', step: '0.5', fallback: 0, max: 500 },
  { key: 'prep_time_min', msg: 'prepTime', hint: true, group: 'timing', step: '1', fallback: DELIVERY_SETTING_DEFAULTS.prepTimeMin, max: 240, integer: true },
  // These two are deliberately loose (owner's call): a huge search radius and a huge attempt
  // count are how you force every driver to be a candidate while testing dispatch. They are
  // safe to leave wide because neither charges anyone money — unlike the fee fields above,
  // which stay tightly capped.
  { key: 'driver_search_radius_km', msg: 'searchRadius', hint: true, group: 'dispatch', step: '0.5', fallback: 3 * KM_PER_MILE, convert: 'dist', max: 12_500 },
  { key: 'driver_max_attempts', msg: 'maxAttempts', hint: true, group: 'dispatch', step: '1', fallback: 3, max: 1_000, integer: true },
  // find_dispatch_candidates refuses a rider whose last GPS fix is older than this. It was
  // a hardcoded 5 minutes, and the rider app only pings while it is OPEN and in the
  // foreground — so a rider who locks their phone becomes undispatchable in five minutes
  // while every screen still shows them online. That is what produced "No rider found" with
  // five riders online.
  { key: 'dispatch_max_gps_age_min', msg: 'gpsAge', hint: true, group: 'dispatch', step: '1', fallback: 5, max: 1_440, integer: true },
  { key: 'offer_ttl_seconds', msg: 'offerTimeout', hint: true, group: 'dispatch', step: '5', fallback: DELIVERY_SETTING_DEFAULTS.offerTtlSeconds, max: 300, integer: true },
  // Stored directly in miles (unlike the km-stored keys above) — the SQL pairing fn
  // claim_batch_sibling reads settings->>'batch_max_detour_mi' as miles.
  { key: 'batch_max_detour_mi', msg: 'stackDetour', hint: true, group: 'dispatch', step: '0.25', fallback: 1.0, max: 10 },
  // branch_driver_pay_cap reads this key and falls back to $50. It had no editor, so the
  // ceiling that silently truncates a long delivery's pay could not be seen or moved from
  // the back office — which only became reachable once the radius above was opened.
  { key: 'driver_max_pay', msg: 'maxPay', hint: true, group: 'pay', step: '1', fallback: 50, max: 1_000 },
];

/** patch_branch_settings refuses busy_extra_prep_min outside 0..240 (22023). */
const BUSY_MAX_MIN = 240;

/** Rendered by hand beside the multiplier slider, not by the group loop. */
const SURGE_FIELDS = FIELDS.filter((f) => f.group === 'surge');

/** Raw database text never reaches the merchant: a known refusal gets its own message,
 *  anything else the generic one. */
function saveErrorKey(err: { message: string; code?: string }): string {
  if (err.code === '42501' || err.message === 'forbidden' || err.message.includes('branch_manager_required')) {
    return 'errors.noPermission';
  }
  return 'errors.generic';
}

// US market shows/enters distances in MILES and rates in $/mile, but everything is
// stored in km / $-per-km so the SQL quote_delivery() and find_dispatch_candidates
// formulas stay unchanged. A "$ per mile" value is stored as its $-per-km equivalent
// (÷ KM_PER_MILE) so base + perKm×distanceKm == base + perMile×distanceMi.
function toDisplayUnit(convert: 'dist' | 'rate' | undefined, km: number): number {
  if (convert === 'dist') return kmToMi(km);
  if (convert === 'rate') return km * KM_PER_MILE;
  return km;
}
function toStoredUnit(convert: 'dist' | 'rate' | undefined, display: number): number {
  if (convert === 'dist') return miToKm(display);
  if (convert === 'rate') return display / KM_PER_MILE;
  return display;
}
const round2disp = (n: number) => Math.round(n * 100) / 100;

/**
 * The exact branches.settings patch this form will write. save() sends it and the preview
 * parses it, so the number on screen is by construction the number quote_delivery() will
 * read back. They used to be two loops: the preview skipped save()'s `max` clamp and its
 * negative-to-fallback rule, so typing -5 into "Per mile" previewed a shrinking fee while
 * Save wrote the $2.00/mi default.
 */
function buildPatch(
  values: Record<NumericKey, string>,
  surge: number,
  busyExtra: string,
): Record<string, number> {
  const patch: Record<string, number> = {};
  for (const f of FIELDS) {
    const n = Number(values[f.key]);
    const raw = Number.isFinite(n) && n >= 0 ? n : toDisplayUnit(f.convert, f.fallback);
    // Clamp here as well as on the input: `max` on a number input is advisory (typing past
    // it, pasting, or a scripted change all bypass it), and these values drive dispatch
    // radius and retry counts.
    const display = Math.min(raw, f.max);
    const stored = toStoredUnit(f.convert, display); // km / $-per-km equivalent
    patch[f.key] = f.integer ? Math.round(stored) : stored;
  }
  patch.busy_extra_prep_min = Math.round(Math.min(BUSY_MAX_MIN, Math.max(0, Number(busyExtra) || 0)));
  patch.delivery_surge_multiplier = Math.min(2, Math.max(1, surge));
  return patch;
}

/** The inputs' starting text for each numeric field: the stored value in the display unit. */
function initialValues(settings: Record<string, unknown> | undefined): Record<NumericKey, string> {
  const out = {} as Record<NumericKey, string>;
  for (const f of FIELDS) {
    const raw = settings?.[f.key];
    const n = typeof raw === 'string' ? Number(raw) : (raw as number | undefined);
    const storedKm = typeof n === 'number' && Number.isFinite(n) ? n : f.fallback;
    out[f.key] = String(round2disp(toDisplayUnit(f.convert, storedKm)));
  }
  return out;
}

function initialBusy(settings: Record<string, unknown> | undefined): string {
  const n = Number(settings?.busy_extra_prep_min);
  return Number.isFinite(n) && n > 0 ? String(n) : '0';
}

function initialSurge(settings: Record<string, unknown> | undefined): number {
  const n = Number(settings?.delivery_surge_multiplier);
  return Number.isFinite(n) && n >= 1 ? Math.min(2, n) : 1;
}

/**
 * What Save would write if nothing on the card were touched. Save compares its patch with this,
 * so an untouched field is never sent, whatever its unit round trip does to the number. A key
 * the row does not have yet (no pause ever set) counts as what the card shows for it (off / 0);
 * re-sending that would clear a pause the kitchen set after this page loaded.
 */
function shownPatch(settings: Record<string, unknown> | undefined): Record<string, number | boolean> {
  return {
    ...buildPatch(initialValues(settings), initialSurge(settings), initialBusy(settings)),
    orders_paused: Boolean(settings?.orders_paused),
    batch_enabled: Boolean(settings?.batch_enabled),
  };
}

export function DeliverySettingsCard({ branchId, settings }: Props) {
  const t = useTranslations('branchOps');
  const tb = useTranslations('branch');
  const router = useRouter();
  const savePatch = useSettingsPatch(branchId, () => shownPatch(settings));
  const [values, setValues] = React.useState<Record<NumericKey, string>>(() => initialValues(settings));
  const [paused, setPaused] = React.useState<boolean>(Boolean(settings?.orders_paused));
  const [batching, setBatching] = React.useState<boolean>(Boolean(settings?.batch_enabled));
  const [busyExtra, setBusyExtra] = React.useState<string>(() => initialBusy(settings));
  const [surge, setSurge] = React.useState<number>(() => initialSurge(settings));
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Live preview of the settings Save is about to write, run through the same formula
  // quote_delivery() runs — same clamps, same fallbacks, same rounding, same order.
  // Echoed back under the two surge inputs in words, because "×1.50" and "3" sitting in
  // separate boxes do not say what a customer will actually be charged.
  const parsed = React.useMemo(
    () => parseDeliverySettings(buildPatch(values, surge, busyExtra)),
    [values, surge, busyExtra],
  );
  // Read back off the patch rather than off the keystrokes, so the prose quotes the clamped
  // value Save will store.
  const surgeFromMi = round2disp(kmToMi(parsed.deliverySurgeFromKm));
  const radiusMi = round2disp(kmToMi(parsed.deliveryRadiusKm));
  const surgeDead = surgeIsUnreachable(parsed);
  // The sample distances come from THIS branch's surge threshold and radius. Fixed 1/3/5 mi
  // rows could not show a surge that starts at 8 mi and wasted a column on "Out of range"
  // whenever the radius was under 5, which is what made the preview read as somebody else's
  // example restaurant.
  const preview = React.useMemo(
    () =>
      previewDistancesMi(parsed).map((mi) => ({ mi, ...quoteDeliveryLocal(parsed, miToKm(mi)) })),
    [parsed],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    // Compared with shownPatch(settings), then with what the last save wrote (useSettingsPatch).
    const { error: updateError } = await savePatch({
      ...buildPatch(values, surge, busyExtra),
      orders_paused: paused,
      batch_enabled: batching,
    });
    setSaving(false);
    if (updateError) {
      console.error('Saving delivery settings failed', updateError);
      // invalid_setting_value: the only value the server bounds here is busy mode's minutes.
      setError(updateError.code === '22023' ? tb('errors.busyMinutesRange', { max: BUSY_MAX_MIN }) : t(saveErrorKey(updateError)));
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <RiderIcon className="h-5 w-5 text-primary" /> {t('delivery.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('delivery.description')}</p>

      {(['fees', 'timing', 'dispatch', 'pay'] as const).map((group) => (
        <div key={group} className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t(`delivery.groups.${group}`)}
          </h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {FIELDS.filter((f) => f.group === group).map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1.5 block text-sm font-medium">
                  {t(`delivery.fields.${f.msg}.label`)}
                </span>
                <input
                  type="number"
                  min={0}
                  max={f.max}
                  step={f.step}
                  inputMode="decimal"
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className={INPUT_CLS}
                />
                {f.hint && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t(`delivery.fields.${f.msg}.hint`)}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('delivery.availability')}
        </h3>
        <div className="mt-2 space-y-3 rounded-xl border border-border p-3">
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium">{t('delivery.pause.label')}</span>
              <span className="block text-xs text-muted-foreground">{t('delivery.pause.hint')}</span>
            </span>
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => setPaused(e.target.checked)}
              className="h-5 w-5 accent-primary"
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium">{t('delivery.stacking.label')}</span>
              <span className="block text-xs text-muted-foreground">{t('delivery.stacking.hint')}</span>
            </span>
            <input
              type="checkbox"
              checked={batching}
              onChange={(e) => setBatching(e.target.checked)}
              className="h-5 w-5 accent-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">{t('delivery.busy.label')}</span>
            <input
              type="number"
              min={0}
              max={BUSY_MAX_MIN}
              step="5"
              inputMode="numeric"
              value={busyExtra}
              onChange={(e) => setBusyExtra(e.target.value)}
              className={INPUT_CLS}
            />
            <span className="mt-1 block text-xs text-muted-foreground">{t('delivery.busy.hint')}</span>
          </label>
          {/* Surge is two numbers — how much, and from how far — and they only make sense
              read together. The distance used to live up in "Customer delivery fee", two
              sections away, each half pointing at the other with "above" and "below". */}
          <div className="rounded-xl border border-border/70 p-3">
            <span className="block text-sm font-medium">{t('delivery.surge.title')}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t('delivery.surge.description')}
            </span>

            <label className="mt-3 block">
              <span className="mb-1.5 flex items-center justify-between text-sm font-medium">
                <span>{t('delivery.surge.multiplier')}</span>
                <span className="font-display text-base font-bold text-primary">×{surge.toFixed(2)}</span>
              </span>
              <input
                type="range"
                min={1}
                max={2}
                step={0.05}
                value={surge}
                onChange={(e) => setSurge(Number(e.target.value))}
                className="h-2 w-full accent-primary"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                {t('delivery.surge.multiplierHint')}
              </span>
            </label>

            {SURGE_FIELDS.map((f) => (
              <label key={f.key} className="mt-3 block">
                <span className="mb-1.5 block text-sm font-medium">
                  {t(`delivery.fields.${f.msg}.label`)}
                </span>
                <input
                  type="number"
                  min={0}
                  max={f.max}
                  step={f.step}
                  inputMode="decimal"
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className={INPUT_CLS}
                />
                {f.hint && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t(`delivery.fields.${f.msg}.hint`)}
                  </span>
                )}
              </label>
            ))}

            <p className="mt-3 text-xs text-muted-foreground">
              {surge <= 1
                ? t('delivery.surge.off')
                : t('delivery.surge.on', { distance: surgeFromMi, multiplier: surge.toFixed(2) })}
            </p>
            {surgeDead && (
              <p className="mt-2 text-xs font-medium text-warning" role="status">
                {t('delivery.surge.unreachable', { distance: surgeFromMi, radius: radiusMi })}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-muted/50 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('delivery.preview.title')}
        </p>
        <div
          className={`mt-2 grid gap-2 text-center text-sm ${
            preview.length >= 3
              ? 'grid-cols-3'
              : preview.length === 2
                ? 'grid-cols-2'
                : 'grid-cols-1'
          }`}
        >
          {preview.map((p) => (
            <div key={p.mi} className="rounded-lg bg-card p-2">
              <p className="text-xs text-muted-foreground">
                {t('delivery.preview.distance', { distance: p.mi })}
              </p>
              {p.deliverable ? (
                <>
                  <p className="font-display text-base font-bold text-primary">${p.fee.toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('delivery.preview.eta', { minutes: p.etaMin })}
                  </p>
                  <p
                    className={
                      p.surge > 1
                        ? 'mt-0.5 text-[11px] font-medium text-primary'
                        : 'mt-0.5 text-[11px] text-muted-foreground'
                    }
                  >
                    {p.surge > 1
                      ? t('delivery.preview.surge', { multiplier: p.surge.toFixed(2) })
                      : t('delivery.preview.noSurge')}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-xs font-medium text-muted-foreground">
                  {t('delivery.preview.outOfRange')}
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{t('delivery.preview.footnote')}</p>
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {t('delivery.save')}
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}
