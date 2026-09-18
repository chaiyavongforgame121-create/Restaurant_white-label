'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle, ArrowRight, Armchair, BellRing, Bike, CalendarClock, Check, ChefHat, Clock,
  Flame, Layers, Loader2, Maximize2, Minimize2, MoreVertical, RotateCcw, ShoppingBag, Undo2,
  UserRound, Volume2, VolumeX, X,
} from 'lucide-react';

import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { OpsToggles } from './ops-toggles';
import {
  ACTIVE_STATUSES, KITCHEN_ORDER_SELECT, REMINDER_INTERVAL_MS, agingTierKey, eightySixTargets, fmtTimer,
  heardOnTap, isLineDone, isOnBoard, laneOf, lateTicketIds, lineMatchesStation, lineStations, mergeSoldOut,
  overlaySnapshot, parseComboContents, parseTimestamp, readyStartedMs, reminderDue, safeElapsedSec,
  speakableTicket, workStartedMs,
  type Delivery, type DriverLite, type Order, type OrderItem, type SoldOutItem, type TierKey,
} from './kitchen-model';
import {
  UNLOCK_EVENTS, audioContext, playChime, speak, speechAvailable, speechLang, unlockAudio,
} from './kitchen-sound';

/* ──────────────────────────────────────────────────────────────────────────
   "Sunset" theme — warm, light, gradient. Kept local to the kitchen surface so
   it never fights the global app theme. (Validated with the user 2026-06-17.)
   ──────────────────────────────────────────────────────────────────────── */
const SUN = {
  page: '#FCF3EA',
  header: 'linear-gradient(120deg,#FF8A1E,#FF5C5C)',
  panel: 'rgba(255,255,255,.55)',
  card: '#FFFFFF',
  cardBorder: 'rgba(170,100,55,.13)',
  line: 'rgba(170,100,55,.10)',
  text: '#3E2A1E',
  muted: '#9C8470',
  faint: '#B8A593',
  qty: '#FF5E2C',
  accent: '#FF6B2C',
  accentBg: 'rgba(255,107,44,.14)',
  accentTx: '#BE4A12',
};

// Lane titles are translated at render: kitchen.lanes.<key>.
const LANES = [
  { key: 'new', grad: 'linear-gradient(120deg,#FFE3A8,#FFCB6A)', tone: '#9A6206' },
  { key: 'cooking', grad: 'linear-gradient(120deg,#FFC39A,#FF9166)', tone: '#A83C12' },
  { key: 'ready', grad: 'linear-gradient(120deg,#A9EDC9,#5FD89B)', tone: '#13794C' },
] as const;

// Whole-card "standout" skins — every card carries a bold, lane-coloured
// background (not flat white) so the board reads at a glance, and escalates to a
// red tint the moment an order ages into Late/Critical.
const LANE_SKIN: Record<string, { bg: string; border: string }> = {
  new: { bg: 'linear-gradient(135deg,#FFF3D4,#FFE1A0)', border: '#F1C05B' },
  cooking: { bg: 'linear-gradient(135deg,#FFE8D8,#FFCBA6)', border: '#F09E63' },
  ready: { bg: 'linear-gradient(135deg,#DCF6E8,#B6EACB)', border: '#6FCB98' },
};
const URGENT_SKIN = { bg: 'linear-gradient(135deg,#FFDAD5,#FFB8B0)', border: '#ED847B' };

// Channel chip labels are translated at render: kitchen.channel.<channel>.
const CHAN: Record<string, { Icon: typeof Bike; bg: string; c: string }> = {
  dine_in: { Icon: Armchair, bg: '#FFE3D6', c: '#C2491F' },
  pickup: { Icon: ShoppingBag, bg: '#FCEBC6', c: '#9A6A0A' },
  delivery: { Icon: Bike, bg: '#E3ECFF', c: '#2E5FB0' },
  qr_ordering: { Icon: Armchair, bg: '#FFE3D6', c: '#C2491F' },
};

// What the primary button does, keyed by the order's CURRENT status. The button text is
// kitchen.action.<status>; the undo toast names the NEXT status (kitchen.toast.advanced).
const ACTION: Record<string, { next: string; Icon: typeof Flame; grad: string; tx: string }> = {
  pending: { next: 'confirmed', Icon: Check, grad: 'linear-gradient(135deg,#FF9326,#FF5C5C)', tx: '#fff' },
  confirmed: { next: 'preparing', Icon: Flame, grad: 'linear-gradient(135deg,#FF9326,#FF5C5C)', tx: '#fff' },
  preparing: { next: 'ready', Icon: Check, grad: 'linear-gradient(135deg,#34D98C,#12A268)', tx: '#fff' },
  ready: { next: 'completed', Icon: ArrowRight, grad: '#F3E9E0', tx: '#5A4636' },
};

// Rider vehicle values stored on drivers.vehicle_type; anything else is shown as stored.
const VEHICLE_TYPES = ['motorcycle', 'car', 'bicycle', 'scooter'];

type Tier = { tier: TierKey; spine: string; pill: string; pc: string; pulse: boolean; ring: boolean };
const TIERS: Record<TierKey, Omit<Tier, 'tier'>> = {
  fresh: { spine: '#E3D8CE', pill: '#F1ECE6', pc: '#9A8676', pulse: false, ring: false },
  work: { spine: 'linear-gradient(180deg,#FBC85A,#F5A623)', pill: '#FCEFCF', pc: '#9A6A0A', pulse: false, ring: false },
  warn: { spine: 'linear-gradient(180deg,#F7A641,#F2802E)', pill: '#FBE1BC', pc: '#A85F00', pulse: false, ring: false },
  late: { spine: 'linear-gradient(180deg,#FB7185,#EF5350)', pill: '#FBD7D4', pc: '#BE362E', pulse: true, ring: false },
  crit: { spine: 'linear-gradient(180deg,#FF6B6B,#E5484D)', pill: 'linear-gradient(135deg,#FF6B6B,#E5484D)', pc: '#fff', pulse: true, ring: true },
};

function agingTier(sec: number, lane: string): Tier {
  const tier = agingTierKey(sec, lane);
  return { tier, ...TIERS[tier] };
}

// place-order's fallback when branches.settings carries neither key.
const DEFAULT_LEAD_MIN = 15;

// Only the mm:ss text has to move every second. A board-wide 1s tick re-rendered every
// card — and while the cards carried framer-motion's `layout`, re-measured and re-committed
// a transform for each one — which is the twitch the cooks reported. Everything else here
// (aging colours, station "drowning", the scheduled drawer) is keyed to thresholds measured
// in minutes, so it reads a coarse tick instead.
const CLOCK_TICK_MS = 1_000;
const AGING_TICK_MS = 5_000;
const BOARD_TICK_MS = 30_000;
/** How often the reminder rule is checked; it rings at most once per REMINDER_INTERVAL_MS. */
const REMINDER_CHECK_MS = 5_000;
/** Coalesce a burst of realtime events (an order and its lines land as several) into one read. */
const RELOAD_COALESCE_MS = 250;
/** A tap on the "Tap to enable order sounds" bar plays the test chime once the context starts,
 *  if it starts within this long (a refused tap must not chime at some later, unrelated one). */
const BAR_CHIME_WINDOW_MS = 3_000;

function useTick(periodMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => window.clearInterval(id);
  }, [periodMs]);
  return now;
}

/** PostgREST returns a one-to-one embed as a single object (or null), never an array, and
 *  every card reads `order.deliveries[0]`. page.tsx normalises the rows it renders on the
 *  server; anything that writes into state after that has to agree, or a dispatched ticket
 *  loses its delivery and offers "Find a rider" for a rider already on the way. */
function asArray<T>(v: T[] | T | null | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function parseMods(m: unknown): { label: string; remove: boolean }[] {
  let arr: unknown[] = [];
  if (Array.isArray(m)) arr = m;
  else if (m && typeof m === 'object') arr = Object.values(m as Record<string, unknown>);
  const out: { label: string; remove: boolean }[] = [];
  for (const it of arr) {
    if (it == null) continue;
    if (typeof it === 'string') { out.push({ label: it, remove: /^(no|without|no-)\b/i.test(it) }); continue; }
    if (typeof it === 'object') {
      const o = it as Record<string, unknown>;
      const name = (o.name ?? o.label ?? o.option_name ?? o.title ?? o.value) as string | undefined;
      if (!name) continue;
      const price = Number(o.price ?? o.price_delta ?? o.extra_price ?? 0);
      const label = price > 0 ? `${name} (+$${price.toFixed(2)})` : String(name);
      out.push({ label, remove: /^(no|without|no-)\b/i.test(String(name)) });
    }
  }
  return out;
}

/** Station codes the platform assigns (menu import, CSV). The code stays the filter and URL value;
 *  only its label is translated, and a code we don't know is shown as it is stored. */
const STATION_CODES = ['hot', 'cold', 'bar', 'dessert', 'expo'] as const;
function isStationCode(value: string): value is (typeof STATION_CODES)[number] {
  return (STATION_CODES as readonly string[]).includes(value);
}

const ALLERGY_RE = /allerg|peanut|\bnut\b|gluten|shellfish|dairy|lactose|sesame|\bsoy\b|vegan|coeliac|celiac/i;

/** Pick the translation key for a failed RPC. The raw PostgREST / Postgres text is server
 *  vocabulary, never a sentence for the cook: a known code gets its own message, anything
 *  else the fallback, and the raw text goes to the console. */
function errorKey(message: string, known: Record<string, string>, fallback: string): string {
  for (const [code, key] of Object.entries(known)) if (message.includes(code)) return key;
  return fallback;
}

/** Per-device preferences (mute, voice). Storage can be missing or throw (private mode, blocked
 *  site data); the board then simply starts with sound on and voice off. */
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not persisted; the setting still holds for this visit */
  }
}

/* ──────────────────────────────────────────────────────────────────────── */

interface Props {
  branchId: string;
  branchName: string;
  /** The branch's IANA zone, for "sold out until" times. */
  branchTimezone: string | null;
  initialOrders: Order[];
  stations: string[];
  activeStation: string | null;
  drivers: DriverLite[];
  /** delivery.manage at this branch: only then is the "assign a rider" picker offered. */
  canAssign: boolean;
  initialSoldOut: SoldOutItem[];
}

interface DispatchFailure {
  error?: string;
  diagnostics?: {
    branch_has_pin?: boolean;
    max_gps_age_min?: number;
    radius_km?: number;
    approved?: number;
    online?: number;
    has_location?: number;
    gps_fresh?: number;
    in_radius?: number;
    not_busy?: number;
  } | null;
}

/** A sentence to show, as a key under kitchen.dispatch plus its values. */
interface DispatchMessage {
  key: string;
  values?: Record<string, number>;
}

/** Turn dispatch-driver's gate counts into the one sentence that tells the merchant where
 *  to look. Ordered from "nothing is set up" to "everyone is busy", so the first failing
 *  gate is the one reported. */
function describeDispatchFailure(body: DispatchFailure | null, status?: number): DispatchMessage {
  // A body with neither `error` nor `diagnostics` never reached dispatch-driver: the gateway
  // rejected the JWT itself (401 "Invalid JWT") or failed (5xx). That is not "no rider".
  if (!body?.error && !body?.diagnostics) {
    if (status === 401) return { key: 'signInAgain' };
    if (status === 403) return { key: 'notAllowed' };
    console.error('dispatch-driver failed with no body, status', status);
    return { key: 'failed' };
  }
  if (body?.error && body.error !== 'no_drivers_available') {
    if (body.error === 'max_attempts_reached') return { key: 'maxAttempts' };
    if (body.error === 'feature_not_entitled') return { key: 'notEntitled' };
    if (body.error === 'delivery_not_dispatchable') return { key: 'notDispatchable' };
    // dispatch-driver checks the caller: 403 without kitchen.access / delivery.manage at the
    // delivery's branch, 401 when the session is gone.
    if (body.error === 'not_authorized') return { key: 'notAllowed' };
    if (body.error === 'auth_required') return { key: 'signInAgain' };
    // Any other code is server vocabulary, not a sentence for the merchant.
    console.error('dispatch-driver failed:', body.error);
    return { key: 'failed' };
  }
  const d = body?.diagnostics;
  if (!d) return { key: 'noneAvailable' };
  if (d.branch_has_pin === false) return { key: 'noPin' };
  if (!d.approved) return { key: 'noneApproved' };
  if (!d.online) return { key: 'noneOnline', values: { approved: d.approved } };
  if (!d.has_location) return { key: 'noLocation', values: { online: d.online } };
  if (!d.gps_fresh) return { key: 'gpsStale', values: { online: d.online, minutes: d.max_gps_age_min ?? 5 } };
  if (!d.not_busy) return { key: 'allBusy', values: { online: d.online } };
  if (!d.in_radius) {
    const mi = d.radius_km != null ? Math.round(d.radius_km / 1.609344) : null;
    return mi != null
      ? { key: 'outOfRangeMiles', values: { online: d.online, miles: mi } }
      : { key: 'outOfRange', values: { online: d.online } };
  }
  return { key: 'noneAvailable' };
}

type Translate = ReturnType<typeof useTranslations<'kitchen'>>;

/** The card's channel chip text (the table for dine-in), also what the voice reads out. */
function chipText(order: Order, t: Translate): string {
  const chanKey = CHAN[order.channel] ? order.channel : 'pickup';
  const chanLabel = t(`channel.${chanKey}`);
  const tableLabel = order.tables ? (order.tables.display_name || t('card.table', { table: order.tables.table_number })) : null;
  return order.channel === 'dine_in' || order.channel === 'qr_ordering' ? (tableLabel ?? chanLabel) : chanLabel;
}

type AudioState = 'unknown' | 'unsupported' | 'locked' | 'running';

export function KitchenView({
  branchId, branchName, branchTimezone, initialOrders, stations, activeStation, drivers, canAssign, initialSoldOut,
}: Props) {
  const t = useTranslations('kitchen');
  const locale = useLocale();
  const stationLabel = (s: string) => (isStationCode(s) ? t(`stations.${s}`) : s);
  const [orders, setOrders] = React.useState<Order[]>(() =>
    initialOrders.map((o) => ({ ...o, deliveries: asArray(o.deliveries) })),
  );
  const [station, setStation] = React.useState<string | null>(activeStation);
  // Aging colours and the "drowning" station pills turn on minute-scale thresholds, so the
  // board reads a coarse clock. The per-second mm:ss lives in its own leaf (TimerPill).
  const now = useTick(AGING_TICK_MS);
  const [paused, setPaused] = React.useState(false);
  const [isFs, setIsFs] = React.useState(false);
  const [scheduledOpen, setScheduledOpen] = React.useState(false);
  const [batchOpen, setBatchOpen] = React.useState(false);
  const [toast, setToast] = React.useState<{ text: string; onUndo: (() => void) | null } | null>(null);
  const [soldOut, setSoldOut] = React.useState<SoldOutItem[]>(initialSoldOut);

  const seenVisibleRef = React.useRef<Set<string> | null>(null);
  const beepStationRef = React.useRef<string | null>(null);
  const lateSeenRef = React.useRef<Set<string> | null>(null);
  const lateStationRef = React.useRef<string | null>(null);
  const lastChimeRef = React.useRef(0);
  // Accepted tickets someone at this screen has seen (a tap or key press since they arrived):
  // the 30-second reminder leaves them alone (reminderDue).
  const heardRef = React.useRef<Set<string>>(new Set());
  const readyAtRef = React.useRef<Record<string, number>>({});
  const toastTimer = React.useRef<number | null>(null);
  // Orders this tab rejected itself: their 'cancelled' echo is not news to the cook.
  const selfCancelledRef = React.useRef<Set<string>>(new Set());
  // Orders announced by an INSERT whose lines may still be on their way (place-order writes the
  // order and its lines in separate requests).
  const awaitingLinesRef = React.useRef<Set<string>>(new Set());
  const ordersRef = React.useRef(orders);
  ordersRef.current = orders;
  // What changed on this board, and when, on a counter that only goes up: an optimistic tap, a
  // realtime echo merged in, a ticket removed. A board read that started before such a change
  // must not paint over it (overlaySnapshot). Keyed by order id, and by menu item id for the
  // sold-out strip.
  const changeClock = React.useRef(0);
  const orderChangedAt = React.useRef<Map<string, number>>(new Map());
  const soldOutChangedAt = React.useRef<Map<string, number>>(new Map());
  const markOrderChanged = React.useCallback((id: string) => {
    orderChangedAt.current.set(id, ++changeClock.current);
  }, []);
  const markSoldOutChanged = React.useCallback((id: string) => {
    soldOutChangedAt.current.set(id, ++changeClock.current);
  }, []);

  const supa = React.useCallback(() => getBrowserClient(), []);

  /* ── sound preferences ─────────────────────────────────────────────────
     Mute and voice are per device and per branch: the pass tablet can stay silent while the
     line's tablet rings. Read after mount, so the server render and the first client render
     agree. */
  const soundKey = `kitchen:sound:${branchId}`;
  const voiceKey = `kitchen:voice:${branchId}`;
  const [soundOn, setSoundOn] = React.useState(true);
  const [voiceOn, setVoiceOn] = React.useState(false);
  const [canSpeak, setCanSpeak] = React.useState(false);
  const [audioState, setAudioState] = React.useState<AudioState>('unknown');
  const [soundMenuOpen, setSoundMenuOpen] = React.useState(false);
  const soundOnRef = React.useRef(soundOn);
  soundOnRef.current = soundOn;
  const voiceOnRef = React.useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  React.useEffect(() => {
    setSoundOn(readPref(soundKey) !== 'off');
    setVoiceOn(readPref(voiceKey) === 'on');
    setCanSpeak(speechAvailable());
  }, [soundKey, voiceKey]);

  const chime = React.useCallback((kind: 'new' | 'reminder' | 'late' | 'test') => {
    if (playChime(kind)) lastChimeRef.current = Date.now();
  }, []);

  /* One AudioContext for the page (kitchen-sound.ts). Browsers keep it suspended until the page
     has had a tap or key press, so the first one anywhere on the board unlocks it. It keeps
     listening: iOS suspends the context again after a call or when the tablet sleeps, and the
     next tap has to bring it back. While sound is on and the context is not running, the board
     says so with a full-width bar instead of staying silently mute.
     Every gesture event is listened to (UNLOCK_EVENTS): with a finger the activation arrives on
     pointerup / touchend, not pointerdown, and pointerdown alone left a tablet needing a second
     tap (an iPad possibly never unlocking from a tap outside a button). The bar itself has no
     click handler: a tap on it is one of these gestures, and the test chime plays when the
     context actually starts (statechange), whichever event started it. A click handler of its
     own raced that: with a mouse, pointerdown already unlocked and the bar unmounted before its
     click, so the chime it promised often never played. */
  const barTapAt = React.useRef(0);
  React.useEffect(() => {
    const c = audioContext();
    if (!c) {
      setAudioState('unsupported');
      return;
    }
    const sync = () => {
      const running = c.state === 'running';
      setAudioState(running ? 'running' : 'locked');
      if (running && barTapAt.current > 0) {
        const fresh = Date.now() - barTapAt.current < BAR_CHIME_WINDOW_MS;
        barTapAt.current = 0;
        if (fresh) chime('test');
      }
    };
    const unlock = (e: Event) => {
      if (c.state === 'running') return;
      if (e.target instanceof Element && e.target.closest('[data-sound-unlock]')) barTapAt.current = Date.now();
      void unlockAudio().then(sync);
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    sync();
    c.addEventListener('statechange', sync);
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, opts);
    return () => {
      c.removeEventListener('statechange', sync);
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock, opts);
    };
  }, [chime]);

  const testSound = () => {
    // Called from a tap, so both the context and speech are allowed to start here.
    void unlockAudio().then((ok) => {
      setAudioState(ok ? 'running' : 'locked');
      if (ok) chime('test');
    });
    if (voiceOnRef.current) speak(t('voice.test'), speechLang(locale));
  };

  const changeSound = (on: boolean) => {
    setSoundOn(on);
    writePref(soundKey, on ? 'on' : 'off');
    if (on) {
      void unlockAudio().then((ok) => {
        setAudioState(ok ? 'running' : 'locked');
        if (ok) chime('reminder');
      });
    }
  };

  const changeVoice = (on: boolean) => {
    setVoiceOn(on);
    writePref(voiceKey, on ? 'on' : 'off');
    // iOS only lets speech start inside a tap; this is one.
    if (on) speak(t('voice.test'), speechLang(locale));
  };

  /* How far ahead of its slot a scheduled order is released to the board, and whether the
     branch is paused. Both come from the settings OpsToggles already reads (and re-reads every
     minute and on focus), because the same keys decide when release_scheduled_orders() fires —
     and a ticket's clock has to start when the cook was meant to start it. */
  const [leadMin, setLeadMin] = React.useState(DEFAULT_LEAD_MIN);
  const onSettings = React.useCallback((s: Record<string, unknown>) => {
    setPaused(Boolean(s.orders_paused));
    const prep = Number(s.prep_time_min ?? DEFAULT_LEAD_MIN);
    const lead = Number(s.schedule_lead_time_min ?? prep);
    if (Number.isFinite(lead) && lead >= 0) setLeadMin(lead);
  }, []);
  const leadMs = leadMin * 60_000;

  /* fullscreen state mirror */
  React.useEffect(() => {
    const h = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  /* Keep the tablet awake while the board is open. A sleeping screen drops the socket and
     misses both the tickets and their chimes. The lock is released whenever the tab is hidden,
     so it is taken again on return; some browsers refuse it before the first tap, so a tap
     retries too. */
  React.useEffect(() => {
    type Sentinel = { released?: boolean; release: () => Promise<void> };
    const wakeLock = (navigator as unknown as { wakeLock?: { request: (type: 'screen') => Promise<Sentinel> } }).wakeLock;
    if (!wakeLock) return;
    let lock: Sentinel | null = null;
    let disposed = false;
    const acquire = async () => {
      if (disposed || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        const next = await wakeLock.request('screen');
        if (disposed) void next.release().catch(() => undefined);
        else lock = next;
      } catch {
        /* refused (battery saver, no gesture yet): the tablet's own display settings apply */
      }
    };
    const retry = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('pointerdown', retry, true);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('pointerdown', retry, true);
      if (lock) void lock.release().catch(() => undefined);
    };
  }, []);

  /* Full reload of the active board. Used on (re)connect, on tab focus and on network
     return: a channel that dropped silently means the deltas below were missed, and a
     kitchen that quietly stops showing tickets is the worst failure this screen has.
     New orders come through here too: the INSERT payload is the bare order row, and building
     the card from it (then reading its lines once) raced place-order's second request and could
     leave a ticket with no lines for good. */
  const reloadSeq = React.useRef(0);
  const emptyRetries = React.useRef(0);
  const requestReloadRef = React.useRef<(delay?: number) => void>(() => undefined);
  const reload = React.useCallback(async () => {
    const seq = ++reloadSeq.current;
    // Changes stamped after this point are newer than what the read below will see.
    const mark = changeClock.current;
    const [{ data, error }, soldOutRead] = await Promise.all([
      supa()
        .from('orders')
        .select(KITCHEN_ORDER_SELECT)
        .eq('branch_id', branchId)
        .in('status', ACTIVE_STATUSES)
        .order('created_at', { ascending: false }),
      // The sold-out strip is re-read with the board: its realtime events are lost with the
      // socket just like the orders', and a dish put back on sale from the back office while the
      // tablet was offline stayed listed (and its 86 row disabled on every card) until a reload.
      supa()
        .from('menu_items')
        .select('id, name, sold_out_until')
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .gt('sold_out_until', new Date().toISOString())
        .order('name'),
    ]);
    // Only the newest read may land: reads from the reconnect path and from realtime events can
    // overlap, and an older one finishing last would paint a stale board.
    if (seq !== reloadSeq.current) return;
    const newerThanRead = (changedAt: Map<string, number>) => (id: string) => (changedAt.get(id) ?? 0) > mark;
    if (!soldOutRead.error && soldOutRead.data) {
      const fresh = soldOutRead.data as SoldOutItem[];
      setSoldOut((curr) =>
        overlaySnapshot(curr, fresh, newerThanRead(soldOutChangedAt.current), () => true)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
    if (error || !data) return;
    const rows = (data as unknown as Order[]).map((o) => ({ ...o, deliveries: asArray(o.deliveries) }));
    setOrders((curr) => {
      const withDeliveries = rows.map((r) => {
        // A refetch must never REMOVE a delivery already on the board either. This runs on
        // connect, reconnect, tab focus and network return, and a moment of replication lag
        // is enough to come back without the embed — which put a "Find a rider" button back
        // under a ticket whose rider was already riding.
        const known = curr.find((o) => o.id === r.id)?.deliveries;
        return r.deliveries.length === 0 && (known?.length ?? 0) > 0 ? { ...r, deliveries: known } : r;
      });
      // A ticket tapped, echoed or removed while this read was in flight keeps what the board
      // holds: the read is older than that change.
      return overlaySnapshot(curr, withDeliveries, newerThanRead(orderChangedAt.current), (o) =>
        ACTIVE_STATUSES.includes(o.status),
      );
    });
    // Stamps at or before this read's start can never outrank it or any later read (only the
    // newest read lands), so they are dropped here and the maps stay small.
    for (const changedAt of [orderChangedAt.current, soldOutChangedAt.current]) {
      for (const [id, at] of changedAt) if (at <= mark) changedAt.delete(id);
    }
    for (const r of rows) if (r.order_items.length > 0) awaitingLinesRef.current.delete(r.id);
    // A just-placed order read between its two writes has no lines yet and is kept off the board
    // (isOnBoard). Its lines' own realtime events trigger a read; this is the fallback in case
    // those were missed, bounded so a genuinely empty order cannot poll forever.
    const waiting = rows.some((r) => r.order_items.length === 0 && Date.now() - new Date(r.created_at).getTime() < 5 * 60_000);
    if (!waiting) emptyRetries.current = 0;
    else if (emptyRetries.current < 3) {
      emptyRetries.current += 1;
      requestReloadRef.current(1_500);
    }
  }, [branchId, supa]);

  /* One read at a time, and a burst of events collapses into one. */
  const reloadState = React.useRef<{ timer: number | null; inFlight: boolean; queued: boolean }>({
    timer: null, inFlight: false, queued: false,
  });
  const requestReload = React.useCallback((delay: number = RELOAD_COALESCE_MS) => {
    const s = reloadState.current;
    if (s.timer) window.clearTimeout(s.timer);
    s.timer = window.setTimeout(() => {
      s.timer = null;
      if (s.inFlight) {
        s.queued = true;
        return;
      }
      s.inFlight = true;
      void reload().finally(() => {
        s.inFlight = false;
        if (s.queued) {
          s.queued = false;
          requestReloadRef.current();
        }
      });
    }, delay);
  }, [reload]);
  requestReloadRef.current = requestReload;
  React.useEffect(() => () => {
    if (reloadState.current.timer) window.clearTimeout(reloadState.current.timer);
  }, []);

  /* realtime: orders, their lines, deliveries, and this branch's sold-out dishes */
  const { healthy: liveHealthy } = useRealtime({
    channel: `kitchen-branch:${branchId}`,
    tables: [
      { table: 'orders', filter: `branch_id=eq.${branchId}` },
      { table: 'deliveries', filter: `branch_id=eq.${branchId}` },
      // order_items has no branch_id to filter on. RLS (order_items_staff) already limits the
      // rows to the viewer's branches, and lines of orders not on this board are ignored.
      { table: 'order_items' },
      { table: 'menu_items', filter: `branch_id=eq.${branchId}`, event: 'UPDATE' },
    ],
    refetch: reload,
    onChange: (payload, table) => {
      if (table === 'menu_items') {
        const m = payload.new as { id?: string; name?: string; sold_out_until?: string | null; is_active?: boolean } | null;
        if (m?.id) {
          const id = m.id;
          setSoldOut((curr) => {
            const next = mergeSoldOut(curr, m, Date.now());
            // Stamp only a real change: every sale updates menu_items (stock).
            if (next !== curr) markSoldOutChanged(id);
            return next;
          });
        }
        return;
      }
      if (table === 'deliveries') {
        const d = payload.new as Partial<Delivery> & { order_id?: string };
        if (!d?.order_id) return;
        markOrderChanged(d.order_id);
        setOrders((curr) => curr.map((o) => {
          if (o.id !== d.order_id) return o;
          // Merge over the row already held rather than rebuilding it from the payload. A
          // postgres_changes payload carries the row as the TABLE has it, not as this board
          // selected it, so an absent accepted_at used to knock a settled card from "Rider
          // assigned" back to "Rider offered…".
          const existing = asArray(o.deliveries)[0];
          return { ...o, deliveries: [{ ...(existing ?? {}), ...d } as Delivery] };
        }));
        return;
      }
      if (table === 'order_items') {
        if (payload.eventType === 'UPDATE') {
          // A line ticked off on another tablet (prep_status), or edited before the kitchen
          // started it.
          const row = payload.new as Partial<OrderItem> & { id?: string; order_id?: string };
          if (!row?.id || !row.order_id) return;
          if (ordersRef.current.some((o) => o.id === row.order_id)) markOrderChanged(row.order_id);
          setOrders((curr) => {
            const idx = curr.findIndex((o) => o.id === row.order_id);
            if (idx < 0 || !curr[idx]!.order_items.some((it) => it.id === row.id)) return curr;
            const next = curr.slice();
            const o = curr[idx]!;
            next[idx] = { ...o, order_items: o.order_items.map((it) => (it.id === row.id ? { ...it, ...row } : it)) };
            return next;
          });
          return;
        }
        // Lines added (place-order's second write, an edit) or removed: re-read the board.
        // A DELETE payload carries only the line's id.
        const orderId = (payload.new as { order_id?: string } | null)?.order_id;
        const lineId = (payload.old as { id?: string } | null)?.id;
        const board = ordersRef.current;
        const affects =
          (!!orderId && (awaitingLinesRef.current.has(orderId) || board.some((o) => o.id === orderId))) ||
          (!!lineId && board.some((o) => o.order_items.some((it) => it.id === lineId)));
        if (affects) requestReload();
        return;
      }
      // orders
      if (payload.eventType === 'DELETE') {
        // place-order deletes an order whose lines failed to insert.
        const id = (payload.old as { id?: string } | null)?.id;
        if (!id) return;
        awaitingLinesRef.current.delete(id);
        markOrderChanged(id);
        setOrders((curr) => (curr.some((o) => o.id === id) ? curr.filter((o) => o.id !== id) : curr));
        return;
      }
      if (payload.eventType === 'INSERT') {
        const id = (payload.new as { id?: string } | null)?.id;
        if (id) awaitingLinesRef.current.add(id);
        requestReload();
        return;
      }
      if (payload.eventType === 'UPDATE') {
        const updated = payload.new as Order;
        const known = ordersRef.current.find((o) => o.id === updated.id);
        if (!ACTIVE_STATUSES.includes(updated.status)) {
          // Cancelled by the diner, the counter or the back office while the kitchen had it up:
          // say so, or the cook finishes a dish nobody will collect.
          if (
            updated.status === 'cancelled' && known && isOnBoard(known) &&
            !selfCancelledRef.current.has(updated.id) &&
            (!station || known.order_items.some((it) => lineMatchesStation(it, station)))
          ) {
            showToast(t('toast.cancelledElsewhere', { ticket: known.order_number.slice(-4) }), null);
            if (soundOnRef.current) chime('late');
          }
          // Stamped so a board read already in flight cannot bring the closed ticket back.
          markOrderChanged(updated.id);
          setOrders((curr) => curr.filter((o) => o.id !== updated.id));
          return;
        }
        // Not on this board yet (an Undo of "Bump" pressed on another tablet, a missed insert),
        // still without its lines, or moved to another table: read it properly.
        if (!known || known.order_items.length === 0 || (known.table_id ?? null) !== (updated.table_id ?? null)) {
          requestReload();
          return;
        }
        markOrderChanged(updated.id);
        setOrders((curr) => curr.map((o) => (o.id === updated.id
          ? { ...o, ...updated, tables: o.tables, order_items: o.order_items, deliveries: o.deliveries }
          : o)));
      }
    },
  });

  const setStationFilter = (s: string | null) => {
    setStation(s);
    const url = new URL(window.location.href);
    if (s) url.searchParams.set('station', s); else url.searchParams.delete('station');
    window.history.replaceState(null, '', url.toString());
  };

  const toggleFs = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* ignore */ }
  };

  /* keyboard: m = mute, f = fullscreen, Esc = close overlays */
  const keyActions = React.useRef({ toggleSound: () => undefined as void, toggleFs });
  keyActions.current = { toggleSound: () => changeSound(!soundOnRef.current), toggleFs };
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // Ctrl+F is the browser's find, not fullscreen; and nothing typed into a field is a shortcut.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (e.key === 'm' || e.key === 'M') keyActions.current.toggleSound();
      else if (e.key === 'f' || e.key === 'F') void keyActions.current.toggleFs();
      else if (e.key === 'Escape') { setScheduledOpen(false); setBatchOpen(false); setSoundMenuOpen(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const showToast = (text: string, onUndo: (() => void) | null) => {
    setToast({ text, onUndo });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  };

  /* advance an order one step, with optimistic update, rollback, and an undo toast */
  const advance = async (order: Order) => {
    const action = ACTION[order.status];
    if (!action) return;
    const prevStatus = order.status;
    const prevReady = readyAtRef.current[order.id];
    const snapshot = order;
    const ticket = order.order_number.slice(-4);
    if (action.next === 'ready') readyAtRef.current[order.id] = Date.now();

    markOrderChanged(order.id);
    setOrders((curr) => curr.map((o) => (o.id === order.id ? { ...o, status: action.next } : o)));

    // Only from the status this card showed. Nothing on the server checks the transition, so an
    // unguarded UPDATE from a tablet that missed a cancel (a dropped socket, a tap inside the
    // echo's latency) brought the cancelled order back to 'preparing', and Bump then ran the
    // completion triggers (loyalty award, tip split) on an order the diner or counter cancelled.
    const { data, error } = await supa()
      .from('orders')
      .update({ status: action.next })
      .eq('id', order.id)
      .eq('branch_id', branchId)
      .eq('status', prevStatus)
      .select('id');
    if (error || !data || data.length === 0) {
      markOrderChanged(order.id);
      setOrders((curr) => curr.map((o) => (o.id === order.id && o.status === action.next ? { ...o, status: prevStatus } : o)));
      if (action.next === 'ready') { if (prevReady != null) readyAtRef.current[order.id] = prevReady; else delete readyAtRef.current[order.id]; }
      if (!error) {
        // No row matched: the order had already moved (cancelled, or advanced on another screen).
        showToast(t('toast.changedElsewhere', { ticket }), null);
        requestReload(0);
        return;
      }
      console.error('kitchen: order status update failed', error.message);
      const key = errorKey(error.message, {
        transfer_payment_not_approved: 'toast.updateUnpaid',
        bad_transition: 'toast.updateNotAllowed',
        invalid_status: 'toast.updateNotAllowed',
      }, 'toast.updateFailed');
      showToast(t(key, { ticket }), null);
      return;
    }
    showToast(t(`toast.advanced.${action.next}`, { ticket }), async () => {
      setToast(null);
      // Putting a ticket back is not an arrival: no chime.
      seenVisibleRef.current?.add(snapshot.id);
      markOrderChanged(snapshot.id);
      setOrders((curr) => (curr.some((o) => o.id === snapshot.id)
        ? curr.map((o) => (o.id === snapshot.id ? { ...o, status: prevStatus } : o))
        : [...curr, { ...snapshot, status: prevStatus }]));
      if (action.next === 'ready') { if (prevReady != null) readyAtRef.current[snapshot.id] = prevReady; else delete readyAtRef.current[snapshot.id]; }
      // Only if the order is still where this tap left it. Without the status guard an Undo
      // pressed after the order had been cancelled elsewhere (the diner, the counter) reopened it.
      const { data, error: undoError } = await supa()
        .from('orders')
        .update({ status: prevStatus })
        .eq('id', snapshot.id)
        .eq('branch_id', branchId)
        .eq('status', action.next)
        .select('id');
      if (undoError || !data || data.length === 0) {
        if (undoError) console.error('kitchen: undo failed', undoError.message);
        const key = undoError
          ? errorKey(undoError.message, { loyalty_points_already_spent: 'toast.undoPointsSpent' }, 'toast.undoFailed')
          : 'toast.undoFailed';
        showToast(t(key, { ticket }), null);
        requestReload(0); // the optimistic put-back was wrong: show what the server has
      }
    });
  };

  const reject = async (order: Order) => {
    const ticket = order.order_number.slice(-4);
    selfCancelledRef.current.add(order.id);
    // The reason is WRITTEN to orders.cancellation_reason — it stays English whatever the board shows.
    const { error } = await supa().rpc('cancel_order', { p_order_id: order.id, p_reason: 'Rejected by kitchen' });
    if (!error) {
      markOrderChanged(order.id);
      setOrders((curr) => curr.filter((o) => o.id !== order.id));
      showToast(t('toast.rejected', { ticket }), null);
    }
    else {
      selfCancelledRef.current.delete(order.id);
      console.error('kitchen: cancel_order failed', error.message);
      const key = errorKey(error.message, {
        cannot_cancel_status: 'toast.rejectClosed',
        not_authorized: 'toast.rejectForbidden',
      }, 'toast.rejectFailed');
      showToast(t(key, { ticket }), null);
    }
  };

  const recall = async (order: Order) => {
    const ticket = order.order_number.slice(-4);
    const prevStatus = order.status;
    const prevReady = readyAtRef.current[order.id];
    markOrderChanged(order.id);
    setOrders((curr) => curr.map((o) => (o.id === order.id ? { ...o, status: 'preparing' } : o)));
    delete readyAtRef.current[order.id];
    // The result was discarded and the success toast shown unconditionally, so a refusal —
    // recall_order raises not_recallable_status and recall_window_passed, both surfacing as
    // a 400 — read to the cook as "recalled to kitchen" while nothing had moved.
    const { error } = await supa().rpc('recall_order', { p_order_id: order.id });
    if (error) {
      // Put the card back where it was: it did not move.
      markOrderChanged(order.id);
      setOrders((curr) => curr.map((o) => (o.id === order.id && o.status === 'preparing' ? { ...o, status: prevStatus } : o)));
      if (prevReady != null) readyAtRef.current[order.id] = prevReady;
      console.error('kitchen: recall_order failed', error.message);
      const key = errorKey(error.message, {
        not_recallable_status: 'toast.recallTooFar',
        recall_window_passed: 'toast.recallWindowPassed',
        not_authorized: 'toast.recallForbidden',
      }, 'toast.recallFailed');
      showToast(t(key, { ticket }), null);
      return;
    }
    showToast(t('toast.recalled', { ticket }), null);
  };

  /**
   * 86 a dish for the rest of the day.
   *
   * set_item_86 stamps sold_out_until, which the menu queries surface as outOfStock, place-order
   * refuses at 409, and the counter and storefront render dimmed and unclickable. It defaults to
   * "until we open tomorrow" computed in the BRANCH's timezone, so the dish returns on its own.
   * is_active stays what it is for — taking a dish off the menu for good.
   *
   * The dish is named by the line's menu_item_id. It used to be looked up by name (ilike +
   * maybeSingle), which failed for a dish renamed since the order, for two dishes with the same
   * name, for a name holding % or _, and for every combo (a combo is not a menu item). A combo
   * offers each dish inside it instead.
   */
  const eightySix = async (itemId: string, itemName: string) => {
    const { data, error } = await supa().rpc('set_item_86', { p_menu_item_id: itemId, p_sold_out: true });
    if (error) {
      console.error('kitchen: set_item_86 failed', error.message);
      showToast(t('toast.eightySixFailed', { item: itemName }), null);
      return;
    }
    const until = (data as { sold_out_until?: string | null } | null)?.sold_out_until ?? null;
    markSoldOutChanged(itemId);
    setSoldOut((curr) => mergeSoldOut(curr, { id: itemId, name: itemName, sold_out_until: until }, Date.now()));
    showToast(t('toast.eightySixDone', { item: itemName }), () => {
      setToast(null);
      void backOnSale({ id: itemId, name: itemName }, true);
    });
  };

  const backOnSale = async (item: { id: string; name: string }, quiet = false) => {
    const { error } = await supa().rpc('set_item_86', { p_menu_item_id: item.id, p_sold_out: false });
    if (error) {
      console.error('kitchen: set_item_86 (back on sale) failed', error.message);
      showToast(t('toast.backOnSaleFailed', { item: item.name }), null);
      return;
    }
    markSoldOutChanged(item.id);
    setSoldOut((curr) => curr.filter((s) => s.id !== item.id));
    if (!quiet) showToast(t('toast.backOnSaleDone', { item: item.name }), null);
  };

  /* Tick a line off (or back on). set_order_item_prep_status is gated by kitchen.access at the
     order's branch and changes that one column only. */
  const togglePrep = async (orderId: string, item: OrderItem) => {
    const next = isLineDone(item) ? 'pending' : 'ready';
    const prev = item.prep_status ?? 'pending';
    const put = (status: string) => {
      markOrderChanged(orderId);
      setOrders((curr) => curr.map((o) => (o.id !== orderId ? o : {
        ...o,
        order_items: o.order_items.map((it) => (it.id === item.id ? { ...it, prep_status: status } : it)),
      })));
    };
    put(next);
    const { error } = await supa().rpc('set_order_item_prep_status', { p_order_item_id: item.id, p_prep_status: next });
    if (error) {
      put(prev);
      console.error('kitchen: set_order_item_prep_status failed', error.message);
      showToast(t('toast.prepFailed', { item: item.item_name }), null);
    }
  };

  const dispatchDriver = async (orderId: string, reset = false) => {
    const { error } = await supa().functions.invoke('dispatch-driver', { body: { order_id: orderId, reset } });
    if (!error) return;
    // supabase-js hides the response body behind error.context. A 503 from dispatch-driver
    // carries the reason the candidate list came back empty, and that reason is the only
    // useful thing on this screen — "No rider found" alone had the merchant chasing riders
    // who were online the whole time.
    let reason: DispatchMessage | null = null;
    try {
      const ctx = (error as unknown as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = (await ctx.json().catch(() => null)) as DispatchFailure | null;
        reason = describeDispatchFailure(body, ctx.status);
      }
    } catch {
      /* body unreadable — fall through to the generic message */
    }
    if (!reason) {
      console.error('kitchen: dispatch-driver failed', error.message);
      reason = { key: 'failed' };
    }
    throw new Error(t(`dispatch.${reason.key}`, reason.values));
  };

  // Manually offer a delivery to a SPECIFIC rider (staff override of auto-dispatch).
  // Goes through the staff_assign_driver RPC — a normal offer the rider still
  // accepts/rejects, but targeted rather than auto-scored.
  const assignDriver = async (deliveryId: string, driverId: string) => {
    const { error } = await (supa() as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    }).rpc('staff_assign_driver', { p_delivery_id: deliveryId, p_driver_id: driverId });
    if (error) {
      console.error('kitchen: staff_assign_driver failed', error.message);
      const key = errorKey(error.message, {
        not_assignable: 'toast.assignTooLate',
        already_accepted: 'toast.assignTooLate',
        driver_not_eligible: 'toast.assignNotEligible',
        driver_busy: 'toast.assignBusy',
        forbidden: 'toast.assignForbidden',
      }, 'toast.assignFailed');
      showToast(t(key), null);
      throw error;
    }
    const d = drivers.find((x) => x.id === driverId);
    showToast(d?.full_name ? t('toast.offeredTo', { name: d.full_name }) : t('toast.offeredToRider'), null);
  };

  /* derive lanes (client-side station filter + FIFO) */
  // awaiting_payment tickets are not work yet — the money has not arrived, and
  // orders_block_unpaid_transfer would refuse the transition anyway, but only AFTER the cook
  // had tried it mid-service. A ticket whose lines have not landed yet is not work either.
  const onBoard = orders.filter(isOnBoard);
  // A line with no station (a hand-built menu, a combo whose dishes span stations) shows on
  // every station's screen: it used to match none of them and vanish from all but "All".
  const visible = station ? onBoard.filter((o) => o.order_items.some((it) => lineMatchesStation(it, station))) : onBoard;
  const scheduled = orders.filter((o) => o.held);
  const visibleRef = React.useRef(visible);
  visibleRef.current = visible;
  const leadMsRef = React.useRef(leadMs);
  leadMsRef.current = leadMs;

  /* New-order chime — gated to the active station.
     Keyed on the tickets actually ON the board, not on orders.length: a
     scheduled order is released by cron flipping held→false, which arrives as an
     UPDATE and leaves the count unchanged, so counting orders let it land
     silently — while a held order still parked in the drawer beeped for nothing. */
  const visibleKey = visible.map((o) => o.id).join(',');
  React.useEffect(() => {
    const ids = visibleKey ? visibleKey.split(',') : [];
    const prev = seenVisibleRef.current;
    // First run, and every station switch, only re-baselines: revealing older
    // tickets by changing the filter is not an arrival and must not chime.
    if (prev === null || beepStationRef.current !== station) {
      seenVisibleRef.current = new Set(ids);
      beepStationRef.current = station;
      return;
    }
    const arrived = ids.filter((id) => !prev.has(id));
    seenVisibleRef.current = new Set(ids);
    if (arrived.length === 0 || !soundOnRef.current) return;
    chime('new');
    if (voiceOnRef.current) {
      for (const id of arrived.slice(0, 3)) {
        const o = visibleRef.current.find((x) => x.id === id);
        if (o) speak(t('voice.newOrder', { channel: chipText(o, t), ticket: speakableTicket(o.order_number) }), speechLang(locale));
      }
    }
  }, [visibleKey, station, chime, t, locale]);

  /* Reminder: a shorter chime every 30 s (counted from the last chime of any kind, so it never
     lands on top of an arrival) while a ticket waits in New unaccepted, or an accepted one arrived
     in the last two minutes and nobody has touched the screen since (see reminderDue). Any tap or
     key press on the board counts as seen for the tickets in New at that moment (heardOnTap). */
  React.useEffect(() => {
    const onGesture = () => {
      for (const id of heardOnTap(visibleRef.current)) heardRef.current.add(id);
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', onGesture, opts);
    window.addEventListener('keydown', onGesture, opts);
    return () => {
      window.removeEventListener('pointerdown', onGesture, opts);
      window.removeEventListener('keydown', onGesture, opts);
    };
  }, []);

  React.useEffect(() => {
    if (!soundOn) return;
    const id = window.setInterval(() => {
      const at = Date.now();
      // Forget tickets that have left the board, so the set stays the size of the board.
      const onBoardIds = new Set(ordersRef.current.map((o) => o.id));
      for (const heardId of heardRef.current) if (!onBoardIds.has(heardId)) heardRef.current.delete(heardId);
      if (at - lastChimeRef.current < REMINDER_INTERVAL_MS) return;
      if (reminderDue(visibleRef.current, at, leadMsRef.current, heardRef.current)) chime('reminder');
    }, REMINDER_CHECK_MS);
    return () => window.clearInterval(id);
  }, [soundOn, chime]);

  /* Escalation: a low tone, once per ticket, when a ticket in New or Cooking turns late.
     Tickets already late when the board loads (or when the station filter reveals them) are
     only noted. */
  React.useEffect(() => {
    const ids = lateTicketIds(visible, now, leadMs);
    const seen = lateSeenRef.current;
    if (seen === null || lateStationRef.current !== station) {
      lateSeenRef.current = new Set([...(seen ?? []), ...ids]);
      lateStationRef.current = station;
      return;
    }
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length > 0 && soundOnRef.current) chime('late');
    // `visible` is rebuilt every render; its ids and the clock are what this rule reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, visibleKey, station, leadMs, chime]);

  const byLane: Record<string, Order[]> = {
    new: visible.filter((o) => laneOf(o.status) === 'new'),
    cooking: visible.filter((o) => laneOf(o.status) === 'cooking'),
    ready: visible.filter((o) => laneOf(o.status) === 'ready'),
  };
  // Newest order first (requested): the freshest tickets sit at the top of each lane.
  const newestFirst = (a: Order, b: Order) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  for (const k of Object.keys(byLane)) byLane[k]!.sort(newestFirst);

  /* The tab title carries the New count, so a backgrounded tab (or a second monitor) still says
     that tickets are waiting. The page's own title comes back when the board closes. */
  const newCount = byLane.new!.length;
  const baseTitle = t('header.title', { branch: branchName });
  React.useEffect(() => {
    const original = document.title;
    return () => { document.title = original; };
  }, []);
  React.useEffect(() => {
    const want = newCount > 0 ? `(${newCount}) ${baseTitle}` : baseTitle;
    const apply = () => {
      if (document.title !== want) document.title = want;
    };
    apply();
    // Next writes the route's metadata title after hydration, which silently replaced the count
    // with "Favornoms Merchant" until the next ticket arrived. Put it back whenever the head changes.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [newCount, baseTitle]);

  /* station counts + "drowning" (any item on a station is Late/Critical) */
  const stationStat: Record<string, { count: number; drown: boolean }> = {};
  for (const s of stations) stationStat[s] = { count: 0, drown: false };
  for (const o of onBoard) {
    const lane = laneOf(o.status);
    const from = lane === 'ready' ? readyStartedMs(o, readyAtRef.current[o.id]) : workStartedMs(o, leadMs);
    const tier = agingTierKey(safeElapsedSec(from, now), lane);
    for (const it of o.order_items) {
      for (const s of lineStations(it, stations)) {
        const stat = stationStat[s];
        if (!stat) continue;
        stat.count += 1;
        if (tier === 'late' || tier === 'crit') stat.drown = true;
      }
    }
  }

  /* batch groups across COOKING (optionally station-filtered). A combo counts as the dishes
     inside it: the cook makes two soups, not "a Family Meal". */
  const batchGroups = React.useMemo(() => {
    const map = new Map<string, { name: string; qty: number; sources: string[] }>();
    const add = (name: string, mods: string, qty: number, ticket: string) => {
      const sig = `${name}|${mods}`;
      const g = map.get(sig) ?? { name, qty: 0, sources: [] };
      g.qty += qty;
      g.sources.push(`#${ticket} ×${qty}`);
      map.set(sig, g);
    };
    for (const o of byLane.cooking ?? []) {
      const ticket = o.order_number.slice(-4);
      for (const it of o.order_items) {
        const parts = it.menu_item_id ? [] : parseComboContents(it.combo_contents);
        if (parts.length > 0) {
          for (const p of parts) {
            if (station && p.station !== null && p.station !== station) continue;
            add(p.name, '', p.quantity * it.quantity, ticket);
          }
          continue;
        }
        if (!lineMatchesStation(it, station)) continue;
        add(it.item_name, parseMods(it.modifiers).map((m) => m.label).sort().join(','), it.quantity, ticket);
      }
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
  }, [byLane.cooking, station]);

  /* the sold-out strip: dishes 86'd at this branch whose time has not run out */
  const liveSoldOut = soldOut.filter((s) => parseTimestamp(s.sold_out_until) > now);
  const soldOutIds = new Set(liveSoldOut.map((s) => s.id));
  const fmtUntil = (iso: string) => {
    const at = parseTimestamp(iso);
    if (!Number.isFinite(at)) return '';
    const opts: Intl.DateTimeFormatOptions = at - Date.now() > 20 * 3600_000
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' };
    try {
      return new Intl.DateTimeFormat(locale, { ...opts, timeZone: branchTimezone ?? undefined }).format(at);
    } catch {
      return new Intl.DateTimeFormat(locale, opts).format(at);
    }
  };

  const soundLocked = soundOn && audioState === 'locked';

  return (
    <div className="flex min-h-dynamic-screen flex-col" style={{ background: SUN.page, color: SUN.text }}>
      {/* header */}
      {/* A dropped socket used to look identical to a quiet kitchen. On a wall-mounted
          tablet nobody is watching for a subtle status word, so a lost connection gets a
          full-width bar — the board is not to be trusted while this is up. */}
      {!liveHealthy && (
        <div
          role="status"
          className="px-4 py-2 text-center text-sm font-semibold text-white"
          style={{ background: '#B62D25' }}
        >
          {t('header.connectionLost')}
        </div>
      )}
      {/* The browser keeps sound locked until someone touches the page, so a board that was
          reloaded and left alone used to stay silent with nothing on screen to say so. No
          onClick: the window-level unlock listeners handle the tap (and play the test chime once
          the context starts), see the audio effect above. */}
      {soundLocked && (
        <button
          type="button"
          data-sound-unlock=""
          className="flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-2.5 text-sm font-semibold"
          style={{ background: '#FFC53D', color: '#4A3000' }}
        >
          <Volume2 className="h-5 w-5" /> {t('header.soundLocked')}
          <span className="text-xs font-normal" style={{ opacity: 0.8 }}>{t('header.soundLockedHint')}</span>
        </button>
      )}
      <header className="flex items-center gap-3 px-4 py-3 text-white" style={{ background: SUN.header }}>
        <span className="grid h-9 w-9 place-items-center rounded-[10px]" style={{ background: 'rgba(255,255,255,.24)' }}>
          <ChefHat className="h-5 w-5" />
        </span>
        <div className="leading-tight">
          <h1 className="text-[15px] font-semibold">{baseTitle}</h1>
          <p className="text-[11px] tracking-wide" style={{ opacity: 0.85 }}>
            {liveHealthy
              ? t('header.statusLive', { count: visible.length })
              : t('header.statusReconnecting', { count: visible.length })}
            {station ? ` · ${stationLabel(station)}` : ''}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {scheduled.length > 0 && (
            <button onClick={() => setScheduledOpen(true)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium" style={{ background: 'rgba(255,255,255,.24)' }}>
              <CalendarClock className="h-4 w-4" />{t('header.scheduled', { count: scheduled.length })}
            </button>
          )}
          <OpsToggles
            branchId={branchId}
            onSettings={onSettings}
            onError={(key) => showToast(t(`toast.${key}`), null)}
          />
          <LocaleSwitcher
            compact
            className="rounded-lg border-transparent bg-white/[.22] text-white [&_svg]:text-white"
          />
          {soundOn ? (
            <HBtn onClick={() => changeSound(false)} label={t('header.mute')}>
              <Volume2 className="h-[18px] w-[18px]" />
            </HBtn>
          ) : (
            // Muted is a state someone forgets: it stays on screen as words, not just an icon.
            <button
              type="button"
              onClick={() => changeSound(true)}
              title={t('header.unmute')}
              aria-label={t('header.unmute')}
              className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold"
              style={{ background: '#fff', color: '#C0382F' }}
            >
              <VolumeX className="h-4 w-4" />{t('header.soundOff')}
            </button>
          )}
          <div className="relative">
            <HBtn onClick={() => setSoundMenuOpen((o) => !o)} label={t('header.soundSettings')}>
              <BellRing className="h-[18px] w-[18px]" />
            </HBtn>
            {soundMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSoundMenuOpen(false)} />
                <div
                  className="absolute right-0 top-11 z-20 w-72 rounded-xl p-3 text-left"
                  style={{ background: SUN.card, color: SUN.text, border: `1px solid ${SUN.cardBorder}`, boxShadow: '0 8px 24px rgba(0,0,0,.14)' }}
                >
                  <button
                    type="button"
                    onClick={testSound}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
                    style={{ background: SUN.accentBg, color: SUN.accentTx }}
                  >
                    <Volume2 className="h-4 w-4" />{t('header.testSound')}
                  </button>
                  {canSpeak && (
                    <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={voiceOn}
                        onChange={(e) => changeVoice(e.target.checked)}
                        className="h-4 w-4 accent-[#FF6B2C]"
                      />
                      {t('header.voice')}
                    </label>
                  )}
                  <p className="mt-2.5 text-xs leading-snug" style={{ color: SUN.muted }}>{t('header.soundHelp')}</p>
                </div>
              </>
            )}
          </div>
          <HBtn onClick={toggleFs} label={t('header.fullscreen')}>{isFs ? <Minimize2 className="h-[18px] w-[18px]" /> : <Maximize2 className="h-[18px] w-[18px]" />}</HBtn>
        </div>
      </header>

      {paused && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-white" style={{ background: 'linear-gradient(120deg,#FF6B6B,#E5484D)' }}>
          <AlertTriangle className="h-4 w-4" /> {t('header.ordersPaused')}
        </div>
      )}

      {/* station bar */}
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-2.5" style={{ borderBottom: `1px solid ${SUN.line}` }}>
        <StationPill label={t('stations.all')} count={onBoard.length} active={!station} onClick={() => setStationFilter(null)} />
        {stations.map((s) => (
          <StationPill key={s} label={stationLabel(s)} count={stationStat[s]?.count ?? 0} drown={stationStat[s]?.drown} active={station === s} onClick={() => setStationFilter(s)} />
        ))}
        <button onClick={() => setBatchOpen((b) => !b)} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium" style={batchOpen ? { background: SUN.accentBg, color: SUN.accentTx, border: `1px solid ${SUN.accent}` } : { color: SUN.muted, border: `1px solid ${SUN.cardBorder}` }}>
          <Layers className="h-4 w-4" /> {t('batch.toggle')}
        </button>
      </div>

      {/* 86'd dishes: what the kitchen has marked sold out, and the way back on sale without
          leaving the board (the undo toast lasts six seconds). */}
      {liveSoldOut.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto px-4 py-2" style={{ background: '#FFF1EE', borderBottom: `1px solid ${SUN.line}` }}>
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#C0382F' }}>
            <Flame className="h-3.5 w-3.5" />{t('eightySix.title')}
          </span>
          {liveSoldOut.map((s) => (
            <span key={s.id} className="flex shrink-0 items-center gap-2 rounded-full py-1 pl-3 pr-1 text-xs" style={{ background: SUN.card, border: '1px solid #F0A8A4', color: SUN.text }}>
              <span className="font-medium">{s.name}</span>
              <span style={{ color: SUN.faint }} suppressHydrationWarning>{t('eightySix.until', { time: fmtUntil(s.sold_out_until) })}</span>
              <button
                type="button"
                onClick={() => void backOnSale(s)}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium"
                style={{ background: '#DCF6E8', color: '#13794C' }}
              >
                {t('eightySix.backOnSale')}
              </button>
            </span>
          ))}
        </div>
      )}

      {batchOpen && (
        <div className="px-4 py-2.5" style={{ background: SUN.panel, borderBottom: `1px solid ${SUN.line}` }}>
          {batchGroups.length === 0 ? (
            <p className="text-xs" style={{ color: SUN.muted }}>{t('batch.empty')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {batchGroups.map((g, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-xl px-3 py-2" style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}` }}>
                  <span className="text-2xl font-semibold tabular-nums" style={{ color: SUN.qty }}>{g.qty}×</span>
                  <div className="leading-tight">
                    <div className="text-sm font-medium" style={{ color: SUN.text }}>{g.name}</div>
                    <div className="text-[11px]" style={{ color: SUN.faint }}>{g.sources.join(' · ')}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* board */}
      <main className="grid min-h-0 flex-1 gap-2.5 p-3" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {LANES.map((lane) => (
          <Column key={lane.key} lane={lane} count={byLane[lane.key]!.length}>
            <AnimatePresence initial={false}>
              {byLane[lane.key]!.length === 0 ? (
                <div className="m-auto px-2 py-6 text-center text-xs" style={{ color: SUN.faint }}>{t('lanes.empty')}</div>
              ) : (
                byLane[lane.key]!.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    lane={lane.key}
                    now={now}
                    station={station}
                    readyAt={readyStartedMs(order, readyAtRef.current[order.id])}
                    workStartedAt={workStartedMs(order, leadMs)}
                    onAdvance={() => advance(order)}
                    onReject={() => reject(order)}
                    onRecall={() => recall(order)}
                    on86={eightySix}
                    soldOutIds={soldOutIds}
                    onTogglePrep={(item) => void togglePrep(order.id, item)}
                    onDispatch={(reset) => dispatchDriver(order.id, reset)}
                    drivers={drivers}
                    canAssign={canAssign}
                    onAssign={assignDriver}
                  />
                ))
              )}
            </AnimatePresence>
          </Column>
        ))}
      </main>

      <AnimatePresence>{toast && <UndoToast text={toast.text} onUndo={toast.onUndo} onClose={() => setToast(null)} />}</AnimatePresence>
      <AnimatePresence>{scheduledOpen && <ScheduledDrawer orders={scheduled} onClose={() => setScheduledOpen(false)} />}</AnimatePresence>
    </div>
  );
}

/* ── building blocks ─────────────────────────────────────────────────────── */

function HBtn({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: 'rgba(255,255,255,.22)', color: '#fff' }}>
      {children}
    </button>
  );
}

function StationPill({ label, count, drown, active, onClick }: { label: string; count: number; drown?: boolean; active: boolean; onClick: () => void }) {
  const style: React.CSSProperties = active
    ? { background: SUN.accentBg, borderColor: SUN.accent, color: SUN.accentTx }
    : drown
      ? { background: '#FBE3E1', borderColor: '#F0A8A4', color: '#C0382F' }
      : { background: SUN.card, borderColor: SUN.cardBorder, color: SUN.muted };
  return (
    <button onClick={onClick} className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium capitalize" style={{ border: '1px solid', ...style }}>
      {label}
      <span className="rounded-full px-1.5 text-[11px] tabular-nums" style={{ background: drown && !active ? 'rgba(229,72,77,.2)' : 'rgba(0,0,0,.08)' }}>{count}</span>
    </button>
  );
}

function Column({ lane, count, children }: { lane: (typeof LANES)[number]; count: number; children: React.ReactNode }) {
  const t = useTranslations('kitchen');
  return (
    <div className="flex min-h-0 flex-col rounded-xl" style={{ background: SUN.panel, border: `1px solid ${SUN.line}` }}>
      <div className="flex items-center gap-2 rounded-t-xl px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{ background: lane.grad, color: lane.tone }}>
        {t(`lanes.${lane.key}`)}
        <span className="ml-auto rounded-full px-2 tabular-nums" style={{ background: 'rgba(0,0,0,.08)', color: lane.tone }}>{count}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">{children}</div>
    </div>
  );
}

// Stop the "Searching for a rider…" spinner after this long and surface a retry
// instead — a fruitless search shouldn't spin forever.
const SEARCH_TIMEOUT_SEC = 120;

function OrderCard({
  order, lane, now, station, readyAt, workStartedAt, onAdvance, onReject, onRecall, on86, soldOutIds, onTogglePrep,
  onDispatch, drivers, canAssign, onAssign,
}: {
  order: Order; lane: string; now: number; station: string | null; readyAt: number; workStartedAt: number;
  onAdvance: () => void; onReject: () => void; onRecall: () => void;
  on86: (menuItemId: string, name: string) => void; soldOutIds: Set<string>; onTogglePrep: (item: OrderItem) => void;
  onDispatch: (reset?: boolean) => void | Promise<void>;
  drivers: DriverLite[]; canAssign: boolean; onAssign: (deliveryId: string, driverId: string) => void | Promise<void>;
}) {
  const t = useTranslations('kitchen');
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [dispatching, setDispatching] = React.useState(false);
  const [dispatchError, setDispatchError] = React.useState(false);
  const [dispatchReason, setDispatchReason] = React.useState<string | null>(null);
  const fromMs = lane === 'ready' ? readyAt : workStartedAt;
  const sec = safeElapsedSec(fromMs, now);
  const tg = agingTier(sec, lane);

  const chanKey = CHAN[order.channel] ? order.channel : 'pickup';
  const chan = CHAN[chanKey]!;
  const ChanIcon = chan.Icon;
  const chip = chipText(order, t);

  const items = order.order_items.filter((it) => lineMatchesStation(it, station));
  const totalLines = order.order_items.length;
  const doneLines = order.order_items.filter(isLineDone).length;
  const targets = eightySixTargets(order.order_items);

  const noteRaw = [order.customer_notes, order.kitchen_notes].filter(Boolean).join(' · ');
  const isAllergy = noteRaw ? ALLERGY_RE.test(noteRaw) : false;

  const action = ACTION[order.status];
  const isDelivery = order.channel === 'delivery';
  const delivery = order.deliveries?.[0];
  const deliveryId = delivery?.id;
  const driverAssigned = delivery && delivery.status !== 'pending' && delivery.status !== 'dispatching';
  // Staff can hand the job to a specific rider until it's actually accepted / in flight.
  const canManualAssign =
    isDelivery && order.status === 'ready' && !!deliveryId &&
    (!delivery || ['pending', 'dispatching', 'assigned'].includes(delivery.status)) &&
    !delivery?.accepted_at;
  // The delivery-ready card uses dispatch/assign controls, not a status advance —
  // so the whole card is tap-to-advance everywhere EXCEPT there.
  const cardClickable = !!action && !(isDelivery && order.status === 'ready');
  const urgent = tg.tier === 'late' || tg.tier === 'crit';
  const skin = urgent ? URGENT_SKIN : (LANE_SKIN[lane] ?? LANE_SKIN.new!);
  const driverLabel = !delivery || delivery.status === 'pending' || delivery.status === 'dispatching'
    ? t('rider.finding')
    : delivery.status === 'assigned'
      ? (delivery.accepted_at ? t('rider.assigned') : t('rider.offered'))
      : t('rider.onTheWay');

  // Show a "searching" indicator the instant the button is pressed (optimistic)
  // and for as long as the delivery sits in pending/dispatching, so the kitchen
  // sees a rider is actively being found instead of a static, unchanged button.
  const searching =
    dispatching || (!!delivery && (delivery.status === 'pending' || delivery.status === 'dispatching'));
  // A passive/cron search that's gone nowhere for SEARCH_TIMEOUT_SEC stops spinning
  // and shows a retry. A fresh manual dispatch click (local `dispatching`) keeps
  // spinning until it resolves, regardless of the order's age.
  const searchTimedOut = !dispatching && searching && sec >= SEARCH_TIMEOUT_SEC;
  React.useEffect(() => {
    if (delivery) setDispatching(false); // the realtime row now drives the searching state
  }, [delivery]);
  const handleDispatch = async (reset = false) => {
    setDispatchError(false);
    setDispatchReason(null);
    setDispatching(true);
    try {
      await onDispatch(reset);
    } catch (e) {
      setDispatching(false); // dispatch failed — surface it so they can retry
      setDispatchError(true);
      setDispatchReason((e as Error)?.message || null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      onClick={cardClickable ? onAdvance : undefined}
      whileTap={cardClickable ? { scale: 0.99 } : undefined}
      role={cardClickable ? 'button' : undefined}
      tabIndex={cardClickable ? 0 : undefined}
      // Only a key pressed on the card itself: Enter on a button inside it (a line's tick, the
      // ⋮ menu) must not also advance the order.
      onKeyDown={cardClickable ? (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onAdvance(); } } : undefined}
      className={`relative rounded-2xl ${cardClickable ? 'cursor-pointer' : ''}`}
      style={{ background: skin.bg, border: `1px solid ${skin.border}`, padding: '11px 12px 12px 16px', boxShadow: tg.ring ? '0 0 0 2px rgba(229,72,77,.5)' : undefined }}
    >
      <span className="absolute left-0 top-0 bottom-0 w-[5px] rounded-l-2xl" style={{ background: tg.spine }} />

      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium uppercase tracking-wide" style={{ background: chan.bg, color: chan.c }}>
          <ChanIcon className="h-3.5 w-3.5" />{chip}
        </span>
        <span className="flex items-center gap-[3px]" aria-hidden>
          {Array.from({ length: totalLines }).map((_, i) => (
            <span key={i} className="h-[7px] w-[7px] rounded-full" style={{ background: i < doneLines ? '#23C16B' : 'rgba(0,0,0,.14)' }} />
          ))}
        </span>
        <TimerPill fromMs={fromMs} lane={lane} />
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button aria-label={t('card.moreActions')} title={t('card.moreActions')} onClick={() => setMenuOpen((m) => !m)} className="grid h-7 w-7 place-items-center rounded-lg" style={{ color: SUN.faint }}>
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-8 z-20 w-56 overflow-hidden rounded-xl py-1 text-left text-sm" style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}`, boxShadow: '0 8px 24px rgba(0,0,0,.14)' }}>
                {/* Any ticket the pass has not started cooking can still be refused. Gating
                    this on 'pending' alone made Reject unreachable for exactly the orders a
                    cook most often has to refuse: payments_confirm_cash_order promotes every
                    cash payment straight to 'confirmed', place-order inserts that row in the
                    same request, and dine-in always pays cash — so a diner at table 4 whose
                    dish has just run out arrived already confirmed, and the cook had to leave
                    the board and find someone with back-office access. cancel_order permits
                    the kitchen role and accepts a confirmed order. */}
                {(order.status === 'pending' || order.status === 'confirmed') && (
                  <MenuRow onClick={() => { setMenuOpen(false); onReject(); }} danger><X className="h-4 w-4" />{t('card.reject')}</MenuRow>
                )}
                {order.status === 'ready' && (
                  <MenuRow onClick={() => { setMenuOpen(false); onRecall(); }}><RotateCcw className="h-4 w-4" />{t('card.recall')}</MenuRow>
                )}
                {isDelivery && order.status === 'ready' && (
                  <MenuRow onClick={() => { setMenuOpen(false); void handleDispatch(true); }}><Bike className="h-4 w-4" />{t('card.redispatch')}</MenuRow>
                )}
                {targets.length > 0 && (
                  <>
                    <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: SUN.faint }}>{t('card.eightySixHeading')}</div>
                    {targets.map((x) => {
                      const out = soldOutIds.has(x.id);
                      return (
                        <MenuRow key={x.id} disabled={out} onClick={() => { setMenuOpen(false); on86(x.id, x.name); }}>
                          <Flame className="h-4 w-4 shrink-0" />
                          <span className="flex-1 truncate">{x.name}</span>
                          {out && <span className="shrink-0 text-[11px]" style={{ color: SUN.faint }}>{t('card.soldOut')}</span>}
                        </MenuRow>
                      );
                    })}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-0.5 text-[11px]" style={{ color: SUN.faint }}>
        #{order.order_number.slice(-4)}
        {delivery?.batch_id && (
          <span className="ml-1.5 inline-flex items-center rounded-md px-1.5 py-px font-semibold" style={{ background: '#E7EEFB', color: '#2E5FB0' }}>
            {t('card.stacked', { stop: delivery.batch_seq ?? '?' })}
          </span>
        )}
      </div>

      <div className="mt-1">
        {items.map((it) => {
          const mods = parseMods(it.modifiers);
          const parts = it.menu_item_id ? [] : parseComboContents(it.combo_contents);
          const done = isLineDone(it);
          const tickLabel = done ? t('card.markLineNotDone', { item: it.item_name }) : t('card.markLineDone', { item: it.item_name });
          return (
            <div key={it.id} className="mt-1.5 flex items-start gap-2.5">
              <span className="text-[21px] font-medium leading-none tabular-nums" style={{ color: SUN.qty, opacity: done ? 0.5 : 1 }}>{it.quantity}×</span>
              <div className="min-w-0 flex-1" style={done ? { opacity: 0.55 } : undefined}>
                <div className={`text-[15px] font-medium leading-tight ${done ? 'line-through' : ''}`} style={{ color: SUN.text }}>{it.item_name}</div>
                {/* A combo is cooked as its dishes: list them, each counted for the whole line.
                    Under a station filter, the dishes another station makes are greyed. */}
                {parts.length > 0 && (
                  <ul className="mt-0.5">
                    {parts.map((p, i) => {
                      const here = !station || p.station === null || p.station === station;
                      return (
                        <li key={`${p.menu_item_id ?? p.name}-${i}`} className="text-[13px] leading-snug" style={{ color: here ? SUN.text : SUN.faint }}>
                          · {p.quantity * it.quantity}× {p.name}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {(mods.length > 0 || it.notes) && (
                  <div className="mt-0.5">
                    {mods.map((m, i) => (
                      <span key={i} className="mr-1 mt-0.5 inline-block rounded-md px-2 py-px text-xs" style={m.remove ? { background: '#FBD9D6', color: '#C0382F' } : { background: '#FCEBCE', color: '#9A6A0A' }}>· {m.label}</span>
                    ))}
                    {it.notes && <span className="mr-1 mt-0.5 inline-block rounded-md px-2 py-px text-xs" style={{ background: '#F1ECE6', color: SUN.muted }}>· {it.notes}</span>}
                  </div>
                )}
              </div>
              {/* Tick a line off. It fills the progress dots above, on every tablet. */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onTogglePrep(it); }}
                aria-label={tickLabel}
                aria-pressed={done}
                title={tickLabel}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full"
                style={done
                  ? { background: '#23C16B', color: '#fff', border: '1.5px solid #23C16B' }
                  : { background: 'rgba(255,255,255,.7)', color: 'rgba(0,0,0,.18)', border: '1.5px solid rgba(0,0,0,.18)' }}
              >
                <Check className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>

      {noteRaw && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium" style={isAllergy ? { background: '#FBD9D6', color: '#B43A33' } : { background: '#FBF0D2', color: '#9A6A0A' }}>
          {isAllergy ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0" />}
          {isAllergy ? t('card.allergyNote', { note: noteRaw }) : noteRaw}
        </div>
      )}

      {isDelivery && order.status === 'ready' ? (
        <div onClick={(e) => e.stopPropagation()}>
          {driverAssigned ? (
            <div className="mt-2.5 flex items-center justify-center gap-2 rounded-[10px] px-3 py-2.5 text-sm font-medium" style={{ background: '#E7EEFB', color: '#2E5FB0' }}>
              <Bike className="h-4 w-4" /> {driverLabel}
            </div>
          ) : dispatchError || searchTimedOut ? (
            <div className="mt-2.5">
              <button onClick={() => handleDispatch(true)} className="flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-sm font-medium active:scale-[.985]" style={{ background: '#FBE3E1', color: '#C0382F' }}>
                <AlertTriangle className="h-4 w-4" /> {t('rider.notFound')}
              </button>
              {dispatchReason && (
                <p className="mt-1.5 px-1 text-[11px] leading-snug" style={{ color: '#C0382F' }}>
                  {dispatchReason}
                </p>
              )}
            </div>
          ) : searching ? (
            <div className="mt-2.5 flex items-center justify-center gap-2 rounded-[10px] px-3 py-2.5 text-sm font-medium" style={{ background: '#E7EEFB', color: '#2E5FB0' }}>
              <Loader2 className="h-4 w-4 animate-spin" /> {t('rider.searching')}
            </div>
          ) : (
            <button onClick={() => handleDispatch(false)} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-sm font-medium active:scale-[.985]" style={{ background: '#E3ECFF', color: '#2E5FB0' }}>
              <Bike className="h-4 w-4" /> {t('rider.find')}
            </button>
          )}
          {/* Assigning a named rider is delivery.manage (staff_assign_driver checks it); the
              kitchen role only finds one automatically. */}
          {canAssign && canManualAssign && drivers.length > 0 && (
            <AssignPicker drivers={drivers} onAssign={(driverId) => onAssign(deliveryId!, driverId)} />
          )}
        </div>
      ) : action ? (
        <button onClick={(e) => { e.stopPropagation(); onAdvance(); }} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-sm font-medium active:scale-[.985]" style={{ background: action.grad, color: action.tx }}>
          <action.Icon className="h-4 w-4" />{t(`action.${order.status}`)}
        </button>
      ) : null}
    </motion.div>
  );
}

/* The one thing on the board that has to move every second. It owns the 1s tick so the
   clock cannot re-render the ticket around it — or the two hundred lines of card beside it.
   An old ticket shows its real age (hours, then days) and stays red. */
function TimerPill({ fromMs, lane }: { fromMs: number; lane: string }) {
  const t = useTranslations('kitchen');
  const now = useTick(CLOCK_TICK_MS);
  const sec = safeElapsedSec(fromMs, now);
  const tg = agingTier(sec, lane);
  return (
    <span className={`ml-auto whitespace-nowrap rounded-lg px-2 py-0.5 text-[17px] font-medium tabular-nums ${tg.pulse ? 'animate-pulse' : ''}`} style={{ background: tg.pill, color: tg.pc }} suppressHydrationWarning>
      {fmtTimer(sec, {
        hoursMinutes: (hours, minutes) => t('timer.hoursMinutes', { hours, minutes }),
        daysHours: (days, hours) => t('timer.daysHours', { days, hours }),
      })}
    </span>
  );
}

function MenuRow({ children, onClick, danger, disabled }: { children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent" style={{ color: danger ? '#C0382F' : SUN.text }}>
      {children}
    </button>
  );
}

/* Manual "assign a specific rider" picker (staff override of auto-dispatch).
   Riders auto-dispatch can reach (online here + free + GPS ping within 5 min) float to the
   top; picking one sends them a targeted offer — that still works for online riders with
   stale GPS, which auto-dispatch skips. */
const GPS_FRESH_MS = 5 * 60_000; // mirrors find_dispatch_candidates' staleness cutoff
function AssignPicker({ drivers, onAssign }: { drivers: DriverLite[]; onAssign: (driverId: string) => void | Promise<void> }) {
  const t = useTranslations('kitchen');
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const nowMs = Date.now(); // fresh each render — the list is only up while someone is picking
  const gpsAge = (d: DriverLite) => (d.location_updated_at ? nowMs - new Date(d.location_updated_at).getTime() : null);
  const rank = (d: DriverLite) => {
    if (!d.is_online) return 3;
    if (d.busy) return 2;
    const age = gpsAge(d);
    return age != null && age < GPS_FRESH_MS ? 0 : 1;
  };
  const ordered = [...drivers].sort((a, b) => rank(a) - rank(b) || a.full_name.localeCompare(b.full_name));
  const pick = async (id: string) => {
    setBusy(id);
    try { await onAssign(id); setOpen(false); } catch { /* caller surfaces the error */ } finally { setBusy(null); }
  };
  return (
    <div className="relative mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] py-2 text-sm font-medium active:scale-[.985]"
        style={{ background: '#FFFFFF', border: `1px solid ${SUN.cardBorder}`, color: SUN.accentTx }}
      >
        <UserRound className="h-4 w-4" /> {t('rider.assign')}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-11 z-20 max-h-56 overflow-y-auto rounded-xl py-1" style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}`, boxShadow: '0 8px 24px rgba(0,0,0,.14)' }}>
            {ordered.length === 0 ? (
              <div className="px-3 py-2 text-xs" style={{ color: SUN.faint }}>{t('rider.noneApproved')}</div>
            ) : (
              ordered.map((d) => {
                const age = gpsAge(d);
                const fresh = age != null && age < GPS_FRESH_MS;
                return (
                  <button
                    key={d.id}
                    disabled={busy !== null}
                    onClick={() => void pick(d.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 disabled:opacity-60"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.is_online ? (d.busy ? '#F5A623' : '#23C16B') : '#CFC2B4' }} />
                    <span className="flex-1 truncate" style={{ color: SUN.text }}>{d.full_name}</span>
                    {d.is_online && !d.busy && (fresh ? (
                      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: '#DCF6E8', color: '#13794C' }}>
                        {age < 60_000 ? t('rider.gpsNow') : t('rider.gpsAge', { minutes: Math.floor(age / 60_000) })}
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: '#FCEBC6', color: '#9A6206' }} title={t('rider.gpsStaleHint')}>
                        {t('rider.gpsStale')}
                      </span>
                    ))}
                    {busy === d.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: SUN.faint }} />
                      : (
                        <span className="text-[11px] capitalize" style={{ color: SUN.faint }}>
                          {!d.is_online
                            ? t('rider.offline')
                            : d.busy
                              ? t('rider.busy')
                              : (VEHICLE_TYPES.includes(d.vehicle_type) ? t(`vehicle.${d.vehicle_type}`) : d.vehicle_type)}
                        </span>
                      )}
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function UndoToast({ text, onUndo, onClose }: { text: string; onUndo: (() => void) | null; onClose: () => void }) {
  const t = useTranslations('kitchen');
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 20, x: '-50%' }}
      className="fixed bottom-5 left-1/2 z-40 flex items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-sm"
      style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}`, color: SUN.text, boxShadow: '0 8px 24px rgba(0,0,0,.16)' }}
    >
      <span>{text}</span>
      {onUndo ? (
        <button onClick={onUndo} className="flex items-center gap-1 font-medium" style={{ color: SUN.accent }}><Undo2 className="h-4 w-4" />{t('toast.undo')}</button>
      ) : (
        <button onClick={onClose} aria-label={t('toast.dismiss')} style={{ color: SUN.faint }}><X className="h-4 w-4" /></button>
      )}
    </motion.div>
  );
}

function ScheduledDrawer({ orders, onClose }: { orders: Order[]; onClose: () => void }) {
  const t = useTranslations('kitchen');
  // "Releases in 12m" only ever moves a minute at a time, and the drawer is open for a
  // moment, so it keeps its own slow clock instead of riding the board's.
  const now = useTick(BOARD_TICK_MS);
  return (
    <motion.div className="fixed inset-0 z-40 flex justify-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} style={{ background: 'rgba(0,0,0,.35)' }}>
      <motion.div
        initial={{ x: 360 }} animate={{ x: 0 }} exit={{ x: 360 }} transition={{ ease: 'easeOut', duration: 0.3 }}
        onClick={(e) => e.stopPropagation()} className="flex h-full w-[340px] flex-col" style={{ background: SUN.page }}
      >
        <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ background: SUN.header }}>
          <CalendarClock className="h-5 w-5" /><h2 className="text-[15px] font-semibold">{t('scheduled.title', { count: orders.length })}</h2>
          <button onClick={onClose} aria-label={t('scheduled.close')} className="ml-auto"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
          {orders.map((o) => {
            const due = o.scheduled_for ? new Date(o.scheduled_for).getTime() : 0;
            const mins = due ? Math.round((due - now) / 60000) : null;
            return (
              <div key={o.id} className="rounded-2xl p-3" style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}` }}>
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: SUN.faint }}>#{o.order_number.slice(-4)}</span>
                  {mins != null && (
                    <span className="rounded-lg px-2 py-0.5 text-xs font-medium" style={mins <= 10 ? { background: '#FBE1BC', color: '#A85F00' } : { background: '#F1ECE6', color: SUN.muted }}>
                      {t('scheduled.releasesIn', { minutes: mins })}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-sm" style={{ color: SUN.text }}>
                  {o.order_items.map((it) => `${it.quantity}× ${it.item_name}`).join(' · ')}
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}
