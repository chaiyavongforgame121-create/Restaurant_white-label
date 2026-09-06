// Per-branch tip configuration, stored in branches.settings.tip_config (jsonb).
// The SQL trigger public.orders_on_complete_record_tip_split() mirrors the
// defaults + distribution math below — keep both sides in sync (see migration
// `tip_config_and_ledger`). This layers on top of tip_pool_distribution(); it
// does NOT replace it.

export type TipChannel = 'pickup' | 'dine_in' | 'delivery' | 'qr_ordering';

/** Per-channel tip presets + who the tip is routed to. */
export interface TipChannelConfig {
  /** Preset tip percentages shown as chips at checkout. Product-fixed: always
   *  TIP_PRESET_DEFAULTS. A `presets` key on the branch row is ignored on read
   *  (parseTipConfig) and never written (serializeTipConfig), so no row can pin a
   *  branch to a different set of chips. */
  presets: number[];
  /** Percent of the tip routed to the "worker" for this channel — the driver for
   *  delivery, the staff pool for pickup/dine_in/qr_ordering. The remainder
   *  (100 - workerPct) is the house cut. Clamped 0..100. */
  workerPct: number;
}

export interface TipConfig {
  pickup: TipChannelConfig;
  dine_in: TipChannelConfig;
  delivery: TipChannelConfig;
  qr_ordering: TipChannelConfig;
}

/** One order's tip broken into who-gets-what. driverCut + houseCut + staffCut === tipAmount. */
export interface TipSplit {
  tipAmount: number;
  driverCut: number;
  houseCut: number;
  staffCut: number;
}

// Checkout offers exactly five choices: these three percentages, a Custom amount
// and a quiet "No tip" control. 0 is never one of the chips.
export const TIP_PRESET_DEFAULTS: number[] = [18, 20, 25];

// Default = 100% of the tip to the worker (driver for delivery, staff pool
// otherwise), 0% house — preserves the pre-config "100% goes to your team"
// behaviour. The SQL trigger uses the same 100/0 fallback.
export const TIP_CONFIG_DEFAULTS: TipConfig = {
  pickup: { presets: [...TIP_PRESET_DEFAULTS], workerPct: 100 },
  dine_in: { presets: [...TIP_PRESET_DEFAULTS], workerPct: 100 },
  delivery: { presets: [...TIP_PRESET_DEFAULTS], workerPct: 100 },
  qr_ordering: { presets: [...TIP_PRESET_DEFAULTS], workerPct: 100 },
};

const CHANNELS: TipChannel[] = ['pickup', 'dine_in', 'delivery', 'qr_ordering'];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampPct(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

/** Parse branches.settings jsonb into a typed TipConfig with defaults. Only the
 *  split is read from the row; the chip list is always the product default. */
export function parseTipConfig(settings: Record<string, unknown> | null | undefined): TipConfig {
  const raw = ((settings ?? {}) as Record<string, unknown>).tip_config as
    | Record<string, unknown>
    | undefined;
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = {} as TipConfig;
  for (const ch of CHANNELS) {
    const c = (src[ch] ?? {}) as Record<string, unknown>;
    const dist = (c.distribution ?? {}) as Record<string, unknown>;
    // delivery routes to the driver; every other channel routes to the staff pool.
    const workerRaw = ch === 'delivery' ? dist.driver : dist.staff;
    out[ch] = {
      // Copied per channel so a caller mutating its list cannot touch the defaults.
      presets: [...TIP_PRESET_DEFAULTS],
      workerPct: clampPct(workerRaw, TIP_CONFIG_DEFAULTS[ch].workerPct),
    };
  }
  return out;
}

/** Serialize a typed TipConfig back to the branches.settings.tip_config jsonb shape
 *  the SQL trigger reads (distribution.driver for delivery, distribution.staff else).
 *
 *  `presets` is intentionally NOT written: they are a product default, and
 *  persisting them would freeze whatever list the merchant's browser happened to
 *  hold into the row the first time they hit Save — pinning that branch to an
 *  outdated set of chips forever. Rows that still carry a presets key are
 *  ignored on read as well (see parseTipConfig). */
export function serializeTipConfig(config: TipConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ch of CHANNELS) {
    const c = config[ch];
    const worker = clampPct(c.workerPct, 100);
    const house = round2(100 - worker);
    out[ch] = {
      distribution: ch === 'delivery' ? { driver: worker, house } : { staff: worker, house },
    };
  }
  return out;
}

/** Preset % buttons for the given channel. */
export function tipPresetsForChannel(config: TipConfig, channel: TipChannel): number[] {
  return (config[channel] ?? config.dine_in).presets;
}

/** The tip the checkout sends with the order. A Custom dollar amount (the raw
 *  string from the USD input) wins over a percentage; a percentage is
 *  subtotal × pct / 100 rounded to the cent. Kept as the exact expression the
 *  checkout used inline so previously agreed totals do not drift; place-order
 *  re-rounds and clamps on its own side. */
export function computeTipAmount(subtotal: number, tipPercent: number, customTip: string): number {
  if (customTip !== '') return Math.max(0, round2(Number(customTip) || 0));
  return Math.round(subtotal * tipPercent) / 100;
}

/** Split a tip into driver/house/staff cuts. MUST stay identical to the SQL trigger
 *  orders_on_complete_record_tip_split(): workerCut = round(tip*pct/100, 2),
 *  houseCut = round(tip - workerCut, 2) (remainder form => cuts sum to tip exactly). */
export function distributeTip(
  config: TipConfig,
  channel: TipChannel,
  tipAmount: number,
): TipSplit {
  const cfg = config[channel] ?? config.dine_in;
  const tip = round2(Math.max(0, tipAmount));
  const workerCut = round2((tip * cfg.workerPct) / 100);
  const houseCut = round2(tip - workerCut);
  return channel === 'delivery'
    ? { tipAmount: tip, driverCut: workerCut, houseCut, staffCut: 0 }
    : { tipAmount: tip, driverCut: 0, houseCut, staffCut: workerCut };
}
