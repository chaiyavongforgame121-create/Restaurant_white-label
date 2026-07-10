// Central platform-owner (white-label admin) configuration, stored as a single
// row in public.platform_settings (jsonb sections). Read/written only through the
// gated RPCs get_platform_settings / update_platform_settings. The SQL side reads
// the same sections via private.platform_json(section) for enforcement (driver
// penalty, new-branch defaults) — keep the fallbacks below in sync with the seed
// row in migration `platform_settings_and_plan_admin`.

export type TipMode = 'hidden' | 'transparent';

/** Driver penalty policy. reject/timeout events in a rolling window trigger a cooldown. */
export interface PenaltyConfig {
  /** Number of penalty events within the window that trips a cooldown. */
  threshold: number;
  /** Rolling window (hours) over which events are counted. */
  windowHours: number;
  /** How long the driver is blocked from going online once tripped (minutes). */
  cooldownMinutes: number;
  /** Count "offer expired without action" (timeout) as a penalty event. */
  countTimeouts: boolean;
  /** Count explicit rejects as a penalty event. */
  countRejects: boolean;
}

/** How delivery tips are surfaced to the driver. */
export interface TipPolicy {
  /** 'hidden' = driver sees only the net tip after the restaurant's split, not the
   *  restaurant's cut. 'transparent' = driver sees the full tip and their share.
   *  NOTE: 'hidden' carries US legal risk (FLSA + CA/NY/Seattle tip-transparency
   *  laws). Have counsel review before enabling in production. */
  mode: TipMode;
}

/** Defaults applied when a new branch is created. */
export interface PlatformDefaults {
  deliveryRadiusMi: number;
  driverSearchRadiusMi: number;
  driverBasePay: number;
  driverPerMilePay: number;
}

/** Known feature flags. Unknown keys are preserved but not typed. */
export interface FeatureFlags {
  combos: boolean;
  reservations: boolean;
  giftCards: boolean;
  voiceOrder: boolean;
}

export interface PlatformSettings {
  penalty: PenaltyConfig;
  tips: TipPolicy;
  defaults: PlatformDefaults;
  features: FeatureFlags;
}

export const PLATFORM_SETTING_DEFAULTS: PlatformSettings = {
  penalty: {
    threshold: 2,
    windowHours: 24,
    cooldownMinutes: 60,
    countTimeouts: true,
    countRejects: true,
  },
  tips: { mode: 'hidden' },
  defaults: {
    deliveryRadiusMi: 5,
    driverSearchRadiusMi: 3,
    driverBasePay: 2,
    driverPerMilePay: 1,
  },
  features: { combos: true, reservations: true, giftCards: true, voiceOrder: false },
};

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

type Json = Record<string, unknown> | null | undefined;

/** Parse the get_platform_settings() jsonb payload into typed settings with defaults. */
export function parsePlatformSettings(raw: Json): PlatformSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = (r.penalty ?? {}) as Record<string, unknown>;
  const t = (r.tips ?? {}) as Record<string, unknown>;
  const d = (r.defaults ?? {}) as Record<string, unknown>;
  const f = (r.features ?? {}) as Record<string, unknown>;
  const def = PLATFORM_SETTING_DEFAULTS;
  return {
    penalty: {
      threshold: Math.max(1, Math.round(num(p.threshold, def.penalty.threshold))),
      windowHours: Math.max(1, num(p.window_hours, def.penalty.windowHours)),
      cooldownMinutes: Math.max(1, num(p.cooldown_minutes, def.penalty.cooldownMinutes)),
      countTimeouts: bool(p.count_timeouts, def.penalty.countTimeouts),
      countRejects: bool(p.count_rejects, def.penalty.countRejects),
    },
    tips: { mode: t.mode === 'transparent' ? 'transparent' : 'hidden' },
    defaults: {
      deliveryRadiusMi: Math.max(0, num(d.delivery_radius_mi, def.defaults.deliveryRadiusMi)),
      driverSearchRadiusMi: Math.max(0, num(d.driver_search_radius_mi, def.defaults.driverSearchRadiusMi)),
      driverBasePay: Math.max(0, num(d.driver_base_pay, def.defaults.driverBasePay)),
      driverPerMilePay: Math.max(0, num(d.driver_per_mile_pay, def.defaults.driverPerMilePay)),
    },
    features: {
      combos: bool(f.combos, def.features.combos),
      reservations: bool(f.reservations, def.features.reservations),
      giftCards: bool(f.gift_cards, def.features.giftCards),
      voiceOrder: bool(f.voice_order, def.features.voiceOrder),
    },
  };
}

/** Serialize a typed patch back to the jsonb sections update_platform_settings expects. */
export function serializePlatformSettings(s: PlatformSettings): Record<string, unknown> {
  return {
    penalty: {
      threshold: s.penalty.threshold,
      window_hours: s.penalty.windowHours,
      cooldown_minutes: s.penalty.cooldownMinutes,
      count_timeouts: s.penalty.countTimeouts,
      count_rejects: s.penalty.countRejects,
    },
    tips: { mode: s.tips.mode },
    defaults: {
      delivery_radius_mi: s.defaults.deliveryRadiusMi,
      driver_search_radius_mi: s.defaults.driverSearchRadiusMi,
      driver_base_pay: s.defaults.driverBasePay,
      driver_per_mile_pay: s.defaults.driverPerMilePay,
    },
    features: {
      combos: s.features.combos,
      reservations: s.features.reservations,
      gift_cards: s.features.giftCards,
      voice_order: s.features.voiceOrder,
    },
  };
}
