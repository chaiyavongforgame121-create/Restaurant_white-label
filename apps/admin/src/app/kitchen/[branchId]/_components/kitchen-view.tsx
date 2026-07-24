'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, ArrowRight, Armchair, Bike, CalendarClock, Check, ChefHat, Clock,
  Flame, Layers, Loader2, Maximize2, Minimize2, MoreVertical, RotateCcw, ShoppingBag, Undo2,
  UserRound, Volume2, VolumeX, X,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { OpsToggles } from './ops-toggles';

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

const LANES = [
  { key: 'new', title: 'NEW', grad: 'linear-gradient(120deg,#FFE3A8,#FFCB6A)', tone: '#9A6206' },
  { key: 'cooking', title: 'COOKING', grad: 'linear-gradient(120deg,#FFC39A,#FF9166)', tone: '#A83C12' },
  { key: 'ready', title: 'READY', grad: 'linear-gradient(120deg,#A9EDC9,#5FD89B)', tone: '#13794C' },
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

const CHAN: Record<string, { Icon: typeof Bike; bg: string; c: string; label: string }> = {
  dine_in: { Icon: Armchair, bg: '#FFE3D6', c: '#C2491F', label: 'Dine-in' },
  pickup: { Icon: ShoppingBag, bg: '#FCEBC6', c: '#9A6A0A', label: 'Pickup' },
  delivery: { Icon: Bike, bg: '#E3ECFF', c: '#2E5FB0', label: 'Delivery' },
  qr_ordering: { Icon: Armchair, bg: '#FFE3D6', c: '#C2491F', label: 'QR table' },
};

// What the primary button does, keyed by the order's CURRENT status.
const ACTION: Record<string, { next: string; label: string; Icon: typeof Flame; grad: string; tx: string }> = {
  pending: { next: 'confirmed', label: 'Accept order', Icon: Check, grad: 'linear-gradient(135deg,#FF9326,#FF5C5C)', tx: '#fff' },
  confirmed: { next: 'preparing', label: 'Start cooking', Icon: Flame, grad: 'linear-gradient(135deg,#FF9326,#FF5C5C)', tx: '#fff' },
  preparing: { next: 'ready', label: 'Mark ready', Icon: Check, grad: 'linear-gradient(135deg,#34D98C,#12A268)', tx: '#fff' },
  ready: { next: 'completed', label: 'Bump', Icon: ArrowRight, grad: '#F3E9E0', tx: '#5A4636' },
};
const NEXT_LABEL: Record<string, string> = { confirmed: 'Accepted', preparing: 'Cooking', ready: 'Ready', completed: 'Bumped' };

type Tier = { tier: string; spine: string; pill: string; pc: string; pulse: boolean; ring: boolean };
const TIERS: Record<string, Omit<Tier, 'tier'>> = {
  fresh: { spine: '#E3D8CE', pill: '#F1ECE6', pc: '#9A8676', pulse: false, ring: false },
  work: { spine: 'linear-gradient(180deg,#FBC85A,#F5A623)', pill: '#FCEFCF', pc: '#9A6A0A', pulse: false, ring: false },
  warn: { spine: 'linear-gradient(180deg,#F7A641,#F2802E)', pill: '#FBE1BC', pc: '#A85F00', pulse: false, ring: false },
  late: { spine: 'linear-gradient(180deg,#FB7185,#EF5350)', pill: '#FBD7D4', pc: '#BE362E', pulse: true, ring: false },
  crit: { spine: 'linear-gradient(180deg,#FF6B6B,#E5484D)', pill: 'linear-gradient(135deg,#FF6B6B,#E5484D)', pc: '#fff', pulse: true, ring: true },
};

function agingTier(sec: number, lane: string): Tier {
  let t: string;
  if (lane === 'ready') t = sec < 180 ? 'fresh' : sec < 300 ? 'warn' : 'late';
  else t = sec < 300 ? 'fresh' : sec < 600 ? 'work' : sec < 900 ? 'warn' : sec < 1200 ? 'late' : 'crit';
  return { tier: t, ...TIERS[t]! };
}

// created_at is timestamptz (ISO) — never seconds. An absurd value (negative skew
// or > 12h, e.g. stale seed rows) means bad data, so clamp it to "fresh" rather
// than render "23889m". No ×1000 normalisation — that would corrupt real stamps.
function safeElapsedSec(fromMs: number, now: number): number {
  if (!Number.isFinite(fromMs)) return 0;
  const raw = Math.floor((now - fromMs) / 1000);
  return raw < 0 || raw > 12 * 3600 ? 0 : raw;
}
function fmtTimer(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
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

const ALLERGY_RE = /allerg|peanut|\bnut\b|gluten|shellfish|dairy|lactose|sesame|\bsoy\b|vegan|coeliac|celiac/i;

/* ──────────────────────────────────────────────────────────────────────── */

interface OrderItem {
  id: string;
  item_name: string;
  quantity: number;
  notes?: string | null;
  prep_status?: string | null;
  station?: string | null;
  modifiers?: unknown;
}
interface Order {
  id: string;
  order_number: string;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | string;
  channel: 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering' | string;
  created_at: string;
  customer_name?: string | null;
  customer_notes?: string | null;
  kitchen_notes?: string | null;
  held?: boolean;
  scheduled_for?: string | null;
  table_id?: string | null;
  tables?: { table_number: string; display_name: string | null } | null;
  order_items: OrderItem[];
  deliveries?: { id: string; status: string; driver_id: string | null; accepted_at: string | null; batch_id?: string | null; batch_seq?: number | null }[];
}

export interface DriverLite {
  id: string;
  full_name: string;
  phone: string | null;
  vehicle_type: string;
  is_online: boolean;
  cooldown_until: string | null;
  location_updated_at: string | null;
}

interface Props {
  branchId: string;
  branchName: string;
  initialOrders: Order[];
  stations: string[];
  activeStation: string | null;
  drivers: DriverLite[];
}

const ACTIVE_STATUSES = ['pending', 'confirmed', 'preparing', 'ready'];

export function KitchenView({ branchId, branchName, initialOrders, stations, activeStation, drivers }: Props) {
  const [orders, setOrders] = React.useState<Order[]>(initialOrders);
  const [station, setStation] = React.useState<string | null>(activeStation);
  const [soundOn, setSoundOn] = React.useState(true);
  const [now, setNow] = React.useState(() => Date.now());
  const [paused, setPaused] = React.useState(false);
  const [isFs, setIsFs] = React.useState(false);
  const [scheduledOpen, setScheduledOpen] = React.useState(false);
  const [batchOpen, setBatchOpen] = React.useState(false);
  const [toast, setToast] = React.useState<{ text: string; onUndo: (() => void) | null } | null>(null);

  const prevCountRef = React.useRef(initialOrders.length);
  const mountNowRef = React.useRef(Date.now());
  const readyAtRef = React.useRef<Record<string, number>>({});
  const toastTimer = React.useRef<number | null>(null);

  const supa = React.useCallback(() => getBrowserClient(), []);

  /* tick every second so mm:ss is smooth and aging recolours live */
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  /* fullscreen state mirror */
  React.useEffect(() => {
    const h = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  /* realtime: orders INSERT/UPDATE + deliveries */
  React.useEffect(() => {
    const supabase = getBrowserClient();
    const channel = supabase
      .channel(`kitchen-branch:${branchId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders', filter: `branch_id=eq.${branchId}` },
        async (payload) => {
          const row = payload.new as Order;
          const { data: items } = await supabase
            .from('order_items')
            .select('id, item_name, quantity, notes, prep_status, station, modifiers')
            .eq('order_id', row.id);
          let tables: Order['tables'] = null;
          if (row.table_id) {
            const { data: t } = await supabase
              .from('tables').select('table_number, display_name').eq('id', row.table_id).maybeSingle();
            tables = (t as Order['tables']) ?? null;
          }
          setOrders((curr) => (curr.some((o) => o.id === row.id) ? curr : [...curr, { ...row, order_items: items ?? [], tables }]));
        })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `branch_id=eq.${branchId}` },
        (payload) => {
          const updated = payload.new as Order;
          setOrders((curr) => {
            if (!ACTIVE_STATUSES.includes(updated.status)) return curr.filter((o) => o.id !== updated.id);
            return curr.map((o) => (o.id === updated.id ? { ...o, ...updated, tables: o.tables ?? updated.tables, order_items: o.order_items, deliveries: o.deliveries } : o));
          });
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries', filter: `branch_id=eq.${branchId}` },
        (payload) => {
          const d = payload.new as { id?: string; order_id?: string; status?: string; driver_id?: string | null; accepted_at?: string | null; batch_id?: string | null; batch_seq?: number | null };
          if (!d?.order_id) return;
          setOrders((curr) => curr.map((o) => (o.id === d.order_id
            ? { ...o, deliveries: [{ id: d.id ?? o.deliveries?.[0]?.id ?? '', status: d.status ?? 'pending', driver_id: d.driver_id ?? null, accepted_at: d.accepted_at ?? null, batch_id: d.batch_id ?? null, batch_seq: d.batch_seq ?? null }] }
            : o)));
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [branchId]);

  /* new-order beep — gated to the active station, with an aging escalation tone */
  React.useEffect(() => {
    if (orders.length > prevCountRef.current && soundOn) beep(880);
    prevCountRef.current = orders.length;
  }, [orders.length, soundOn]);

  /* keyboard: m = mute, f = fullscreen, Esc = close overlays */
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') setSoundOn((s) => !s);
      else if (e.key === 'f' || e.key === 'F') void toggleFs();
      else if (e.key === 'Escape') { setScheduledOpen(false); setBatchOpen(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

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
    if (action.next === 'ready') readyAtRef.current[order.id] = Date.now();

    setOrders((curr) => curr.map((o) => (o.id === order.id ? { ...o, status: action.next } : o)));

    const { error } = await supa().from('orders').update({ status: action.next }).eq('id', order.id).eq('branch_id', branchId);
    if (error) {
      setOrders((curr) => curr.map((o) => (o.id === order.id ? { ...o, status: prevStatus } : o)));
      if (action.next === 'ready') { if (prevReady != null) readyAtRef.current[order.id] = prevReady; else delete readyAtRef.current[order.id]; }
      showToast(`Couldn't update #${order.order_number.slice(-4)} — ${error.message}`, null);
      return;
    }
    showToast(`#${order.order_number.slice(-4)} → ${NEXT_LABEL[action.next] ?? action.next}`, async () => {
      setToast(null);
      setOrders((curr) => (curr.some((o) => o.id === snapshot.id)
        ? curr.map((o) => (o.id === snapshot.id ? { ...o, status: prevStatus } : o))
        : [...curr, { ...snapshot, status: prevStatus }]));
      if (action.next === 'ready') { if (prevReady != null) readyAtRef.current[snapshot.id] = prevReady; else delete readyAtRef.current[snapshot.id]; }
      await supa().from('orders').update({ status: prevStatus }).eq('id', snapshot.id).eq('branch_id', branchId);
    });
  };

  const reject = async (order: Order) => {
    const { error } = await supa().rpc('cancel_order', { p_order_id: order.id, p_reason: 'Rejected by kitchen' });
    if (!error) { setOrders((curr) => curr.filter((o) => o.id !== order.id)); showToast(`#${order.order_number.slice(-4)} rejected`, null); }
    else showToast(`Reject failed — ${error.message}`, null);
  };

  const recall = async (order: Order) => {
    setOrders((curr) => curr.map((o) => (o.id === order.id ? { ...o, status: 'preparing' } : o)));
    delete readyAtRef.current[order.id];
    await supa().rpc('recall_order', { p_order_id: order.id });
    showToast(`#${order.order_number.slice(-4)} recalled to kitchen`, null);
  };

  const eightySix = async (itemName: string) => {
    const supabase = supa();
    const { data: row } = await supabase.from('menu_items').select('id').eq('branch_id', branchId).ilike('name', itemName).maybeSingle();
    if (!row) { showToast(`Couldn't find "${itemName}" — may already be 86'd`, null); return; }
    const { error } = await supabase.rpc('toggle_item_availability', { p_item_id: row.id, p_active: false });
    if (error) { showToast(`86 failed — ${error.message}`, null); return; }
    showToast(`86'd ${itemName}`, async () => {
      setToast(null);
      await supabase.rpc('toggle_item_availability', { p_item_id: row.id, p_active: true });
    });
  };

  const dispatchDriver = async (orderId: string, reset = false) => {
    const { error } = await supa().functions.invoke('dispatch-driver', { body: { order_id: orderId, reset } });
    if (error) throw error;
  };

  // Manually offer a delivery to a SPECIFIC rider (staff override of auto-dispatch).
  // Goes through the staff_assign_driver RPC — a normal offer the rider still
  // accepts/rejects, but targeted rather than auto-scored.
  const assignDriver = async (deliveryId: string, driverId: string) => {
    const { error } = await (supa() as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    }).rpc('staff_assign_driver', { p_delivery_id: deliveryId, p_driver_id: driverId });
    if (error) {
      showToast(`Couldn't assign rider — ${error.message}`, null);
      throw error;
    }
    const d = drivers.find((x) => x.id === driverId);
    showToast(`Offered to ${d?.full_name ?? 'rider'}`, null);
  };

  /* derive lanes (client-side station filter + FIFO) */
  const matchesStation = React.useCallback(
    (o: Order) => !station || o.order_items.some((it) => it.station === station),
    [station],
  );
  const visible = orders.filter((o) => !o.held && ACTIVE_STATUSES.includes(o.status) && matchesStation(o));
  const scheduled = orders.filter((o) => o.held);
  const byLane: Record<string, Order[]> = {
    new: visible.filter((o) => o.status === 'pending' || o.status === 'confirmed'),
    cooking: visible.filter((o) => o.status === 'preparing'),
    ready: visible.filter((o) => o.status === 'ready'),
  };
  // Newest order first (requested): the freshest tickets sit at the top of each lane.
  const newestFirst = (a: Order, b: Order) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  for (const k of Object.keys(byLane)) byLane[k]!.sort(newestFirst);

  /* station counts + "drowning" (any item on a station is Late/Critical) */
  const stationStat: Record<string, { count: number; drown: boolean }> = {};
  for (const s of stations) stationStat[s] = { count: 0, drown: false };
  for (const o of orders) {
    if (o.held || !ACTIVE_STATUSES.includes(o.status)) continue;
    const lane = o.status === 'preparing' ? 'cooking' : o.status === 'ready' ? 'ready' : 'new';
    const from = lane === 'ready' ? (readyAtRef.current[o.id] ?? mountNowRef.current) : new Date(o.created_at).getTime();
    const tier = agingTier(safeElapsedSec(from, now), lane).tier;
    for (const it of o.order_items) {
      if (it.station && stationStat[it.station]) {
        stationStat[it.station]!.count += 1;
        if (tier === 'late' || tier === 'crit') stationStat[it.station]!.drown = true;
      }
    }
  }

  /* batch groups across COOKING (optionally station-filtered) */
  const batchGroups = React.useMemo(() => {
    const map = new Map<string, { name: string; qty: number; sources: string[] }>();
    for (const o of byLane.cooking ?? []) {
      for (const it of o.order_items) {
        if (station && it.station !== station) continue;
        const sig = `${it.item_name}|${parseMods(it.modifiers).map((m) => m.label).sort().join(',')}`;
        const g = map.get(sig) ?? { name: it.item_name, qty: 0, sources: [] };
        g.qty += it.quantity;
        g.sources.push(`#${o.order_number.slice(-4)} ×${it.quantity}`);
        map.set(sig, g);
      }
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
  }, [byLane.cooking, station]);

  return (
    <div className="flex min-h-dynamic-screen flex-col" style={{ background: SUN.page, color: SUN.text }}>
      {/* header */}
      <header className="flex items-center gap-3 px-4 py-3 text-white" style={{ background: SUN.header }}>
        <span className="grid h-9 w-9 place-items-center rounded-[10px]" style={{ background: 'rgba(255,255,255,.24)' }}>
          <ChefHat className="h-5 w-5" />
        </span>
        <div className="leading-tight">
          <h1 className="text-[15px] font-semibold">{branchName} · Kitchen</h1>
          <p className="text-[11px] tracking-wide" style={{ opacity: 0.85 }}>
            {visible.length} active · live{station ? ` · ${station}` : ''}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {scheduled.length > 0 && (
            <button onClick={() => setScheduledOpen(true)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium" style={{ background: 'rgba(255,255,255,.24)' }}>
              <CalendarClock className="h-4 w-4" />{scheduled.length} scheduled
            </button>
          )}
          <OpsToggles branchId={branchId} onPaused={setPaused} />
          <HBtn onClick={() => setSoundOn((s) => !s)} label={soundOn ? 'Mute' : 'Unmute'}>
            {soundOn ? <Volume2 className="h-[18px] w-[18px]" /> : <VolumeX className="h-[18px] w-[18px]" />}
          </HBtn>
          <HBtn onClick={toggleFs} label="Fullscreen">{isFs ? <Minimize2 className="h-[18px] w-[18px]" /> : <Maximize2 className="h-[18px] w-[18px]" />}</HBtn>
        </div>
      </header>

      {paused && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-white" style={{ background: 'linear-gradient(120deg,#FF6B6B,#E5484D)' }}>
          <AlertTriangle className="h-4 w-4" /> Orders paused — customers cannot order while this is on.
        </div>
      )}

      {/* station bar */}
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-2.5" style={{ borderBottom: `1px solid ${SUN.line}` }}>
        <StationPill label="All" count={visible.length} active={!station} onClick={() => setStationFilter(null)} />
        {stations.map((s) => (
          <StationPill key={s} label={s} count={stationStat[s]?.count ?? 0} drown={stationStat[s]?.drown} active={station === s} onClick={() => setStationFilter(s)} />
        ))}
        <button onClick={() => setBatchOpen((b) => !b)} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium" style={batchOpen ? { background: SUN.accentBg, color: SUN.accentTx, border: `1px solid ${SUN.accent}` } : { color: SUN.muted, border: `1px solid ${SUN.cardBorder}` }}>
          <Layers className="h-4 w-4" /> Batch view
        </button>
      </div>

      {batchOpen && (
        <div className="px-4 py-2.5" style={{ background: SUN.panel, borderBottom: `1px solid ${SUN.line}` }}>
          {batchGroups.length === 0 ? (
            <p className="text-xs" style={{ color: SUN.muted }}>Nothing cooking to batch right now.</p>
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
                <div className="m-auto px-2 py-6 text-center text-xs" style={{ color: SUN.faint }}>All clear, chef.</div>
              ) : (
                byLane[lane.key]!.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    lane={lane.key}
                    now={now}
                    station={station}
                    readyAt={readyAtRef.current[order.id] ?? mountNowRef.current}
                    onAdvance={() => advance(order)}
                    onReject={() => reject(order)}
                    onRecall={() => recall(order)}
                    on86={eightySix}
                    onDispatch={(reset) => dispatchDriver(order.id, reset)}
                    drivers={drivers}
                    onAssign={assignDriver}
                  />
                ))
              )}
            </AnimatePresence>
          </Column>
        ))}
      </main>

      <AnimatePresence>{toast && <UndoToast text={toast.text} onUndo={toast.onUndo} onClose={() => setToast(null)} />}</AnimatePresence>
      <AnimatePresence>{scheduledOpen && <ScheduledDrawer orders={scheduled} now={now} onClose={() => setScheduledOpen(false)} />}</AnimatePresence>
    </div>
  );
}

/* ── building blocks ─────────────────────────────────────────────────────── */

function HBtn({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: 'rgba(255,255,255,.22)', color: '#fff' }}>
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
  return (
    <div className="flex min-h-0 flex-col rounded-xl" style={{ background: SUN.panel, border: `1px solid ${SUN.line}` }}>
      <div className="flex items-center gap-2 rounded-t-xl px-3 py-2.5 text-xs font-semibold tracking-wider" style={{ background: lane.grad, color: lane.tone }}>
        {lane.title}
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
  order, lane, now, station, readyAt, onAdvance, onReject, onRecall, on86, onDispatch, drivers, onAssign,
}: {
  order: Order; lane: string; now: number; station: string | null; readyAt: number;
  onAdvance: () => void; onReject: () => void; onRecall: () => void; on86: (name: string) => void; onDispatch: (reset?: boolean) => void | Promise<void>;
  drivers: DriverLite[]; onAssign: (deliveryId: string, driverId: string) => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [dispatching, setDispatching] = React.useState(false);
  const [dispatchError, setDispatchError] = React.useState(false);
  const fromMs = lane === 'ready' ? readyAt : new Date(order.created_at).getTime();
  const sec = safeElapsedSec(fromMs, now);
  const tg = agingTier(sec, lane);

  const chan = CHAN[order.channel] ?? CHAN.pickup!;
  const ChanIcon = chan.Icon;
  const tableLabel = order.tables ? (order.tables.display_name || `Table ${order.tables.table_number}`) : null;
  const chipText = order.channel === 'dine_in' || order.channel === 'qr_ordering'
    ? (tableLabel ?? chan.label) : chan.label;

  const items = station ? order.order_items.filter((it) => it.station === station) : order.order_items;
  const totalLines = order.order_items.length;
  const doneLines = order.order_items.filter((it) => it.prep_status === 'ready').length;

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
    ? 'Finding a rider…'
    : delivery.status === 'assigned'
      ? (delivery.accepted_at ? 'Rider assigned ✓' : 'Rider offered…')
      : 'Rider on the way';

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
    setDispatching(true);
    try {
      await onDispatch(reset);
    } catch {
      setDispatching(false); // dispatch failed — surface it so they can retry
      setDispatchError(true);
    }
  };

  return (
    <motion.div
      layout layoutId={order.id}
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      onClick={cardClickable ? onAdvance : undefined}
      whileTap={cardClickable ? { scale: 0.99 } : undefined}
      role={cardClickable ? 'button' : undefined}
      tabIndex={cardClickable ? 0 : undefined}
      onKeyDown={cardClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdvance(); } } : undefined}
      className={`relative rounded-2xl ${cardClickable ? 'cursor-pointer' : ''}`}
      style={{ background: skin.bg, border: `1px solid ${skin.border}`, padding: '11px 12px 12px 16px', boxShadow: tg.ring ? '0 0 0 2px rgba(229,72,77,.5)' : undefined }}
    >
      <span className="absolute left-0 top-0 bottom-0 w-[5px] rounded-l-2xl" style={{ background: tg.spine }} />

      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium uppercase tracking-wide" style={{ background: chan.bg, color: chan.c }}>
          <ChanIcon className="h-3.5 w-3.5" />{chipText}
        </span>
        <span className="flex items-center gap-[3px]">
          {Array.from({ length: totalLines }).map((_, i) => (
            <span key={i} className="h-[7px] w-[7px] rounded-full" style={{ background: i < doneLines ? '#23C16B' : 'rgba(0,0,0,.14)' }} />
          ))}
        </span>
        <span className={`ml-auto rounded-lg px-2 py-0.5 text-[17px] font-medium tabular-nums ${tg.pulse ? 'animate-pulse' : ''}`} style={{ background: tg.pill, color: tg.pc }}>
          {fmtTimer(sec)}
        </span>
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button aria-label="More actions" onClick={() => setMenuOpen((m) => !m)} className="grid h-7 w-7 place-items-center rounded-lg" style={{ color: SUN.faint }}>
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-8 z-20 w-52 overflow-hidden rounded-xl py-1 text-left text-sm" style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}`, boxShadow: '0 8px 24px rgba(0,0,0,.14)' }}>
                {order.status === 'pending' && (
                  <MenuRow onClick={() => { setMenuOpen(false); onReject(); }} danger><X className="h-4 w-4" />Reject order</MenuRow>
                )}
                {order.status === 'ready' && (
                  <MenuRow onClick={() => { setMenuOpen(false); onRecall(); }}><RotateCcw className="h-4 w-4" />Recall to kitchen</MenuRow>
                )}
                {isDelivery && order.status === 'ready' && (
                  <MenuRow onClick={() => { setMenuOpen(false); void handleDispatch(true); }}><Bike className="h-4 w-4" />Re-dispatch (start over)</MenuRow>
                )}
                <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: SUN.faint }}>86 an item</div>
                {order.order_items.map((it) => (
                  <MenuRow key={it.id} onClick={() => { setMenuOpen(false); on86(it.item_name); }}>
                    <Flame className="h-4 w-4" />{it.item_name}
                  </MenuRow>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-0.5 text-[11px]" style={{ color: SUN.faint }}>
        #{order.order_number.slice(-4)}
        {delivery?.batch_id && (
          <span className="ml-1.5 inline-flex items-center rounded-md px-1.5 py-px font-semibold" style={{ background: '#E7EEFB', color: '#2E5FB0' }}>
            🔗 Stacked · stop {delivery.batch_seq ?? '?'} — pack both bags for one rider
          </span>
        )}
      </div>

      <div className="mt-1">
        {items.map((it) => {
          const mods = parseMods(it.modifiers);
          return (
            <div key={it.id} className="mt-1.5 flex items-baseline gap-2.5">
              <span className="text-[21px] font-medium leading-none tabular-nums" style={{ color: SUN.qty }}>{it.quantity}×</span>
              <div>
                <div className="text-[15px] font-medium leading-tight" style={{ color: SUN.text }}>{it.item_name}</div>
                {(mods.length > 0 || it.notes) && (
                  <div className="mt-0.5">
                    {mods.map((m, i) => (
                      <span key={i} className="mr-1 mt-0.5 inline-block rounded-md px-2 py-px text-xs" style={m.remove ? { background: '#FBD9D6', color: '#C0382F' } : { background: '#FCEBCE', color: '#9A6A0A' }}>· {m.label}</span>
                    ))}
                    {it.notes && <span className="mr-1 mt-0.5 inline-block rounded-md px-2 py-px text-xs" style={{ background: '#F1ECE6', color: SUN.muted }}>· {it.notes}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {noteRaw && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium" style={isAllergy ? { background: '#FBD9D6', color: '#B43A33' } : { background: '#FBF0D2', color: '#9A6A0A' }}>
          {isAllergy ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0" />}
          {isAllergy ? `Allergy / note: ${noteRaw}` : noteRaw}
        </div>
      )}

      {isDelivery && order.status === 'ready' ? (
        <div onClick={(e) => e.stopPropagation()}>
          {driverAssigned ? (
            <div className="mt-2.5 flex items-center justify-center gap-2 rounded-[10px] px-3 py-2.5 text-sm font-medium" style={{ background: '#E7EEFB', color: '#2E5FB0' }}>
              <Bike className="h-4 w-4" /> {driverLabel}
            </div>
          ) : dispatchError || searchTimedOut ? (
            <button onClick={() => handleDispatch(true)} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-sm font-medium active:scale-[.985]" style={{ background: '#FBE3E1', color: '#C0382F' }}>
              <AlertTriangle className="h-4 w-4" /> No rider found — tap to retry
            </button>
          ) : searching ? (
            <div className="mt-2.5 flex items-center justify-center gap-2 rounded-[10px] px-3 py-2.5 text-sm font-medium" style={{ background: '#E7EEFB', color: '#2E5FB0' }}>
              <Loader2 className="h-4 w-4 animate-spin" /> Searching for a rider…
            </div>
          ) : (
            <button onClick={() => handleDispatch(false)} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-sm font-medium active:scale-[.985]" style={{ background: '#E3ECFF', color: '#2E5FB0' }}>
              <Bike className="h-4 w-4" /> Find a rider
            </button>
          )}
          {canManualAssign && drivers.length > 0 && (
            <AssignPicker drivers={drivers} onAssign={(driverId) => onAssign(deliveryId!, driverId)} />
          )}
        </div>
      ) : action ? (
        <button onClick={(e) => { e.stopPropagation(); onAdvance(); }} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-sm font-medium active:scale-[.985]" style={{ background: action.grad, color: action.tx }}>
          <action.Icon className="h-4 w-4" />{action.label}
        </button>
      ) : null}
    </motion.div>
  );
}

function MenuRow({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5" style={{ color: danger ? '#C0382F' : SUN.text }}>
      {children}
    </button>
  );
}

/* Manual "assign a specific rider" picker (staff override of auto-dispatch).
   Riders auto-dispatch can reach (online + GPS ping within 5 min) float to the
   top; picking one sends them a targeted offer — that still works for online
   riders with stale GPS, which auto-dispatch skips. */
const GPS_FRESH_MS = 5 * 60_000; // mirrors find_dispatch_candidates' staleness cutoff
function AssignPicker({ drivers, onAssign }: { drivers: DriverLite[]; onAssign: (driverId: string) => void | Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const nowMs = Date.now(); // fresh each render — the kitchen re-renders on a 1s tick
  const gpsAge = (d: DriverLite) => (d.location_updated_at ? nowMs - new Date(d.location_updated_at).getTime() : null);
  const rank = (d: DriverLite) => {
    if (!d.is_online) return 2;
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
        <UserRound className="h-4 w-4" /> Assign to a rider
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-11 z-20 max-h-56 overflow-y-auto rounded-xl py-1" style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}`, boxShadow: '0 8px 24px rgba(0,0,0,.14)' }}>
            {ordered.length === 0 ? (
              <div className="px-3 py-2 text-xs" style={{ color: SUN.faint }}>No approved riders for this branch.</div>
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
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.is_online ? '#23C16B' : '#CFC2B4' }} />
                    <span className="flex-1 truncate" style={{ color: SUN.text }}>{d.full_name}</span>
                    {d.is_online && (fresh ? (
                      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: '#DCF6E8', color: '#13794C' }}>
                        {age < 60_000 ? 'GPS now' : `GPS ${Math.floor(age / 60_000)}m`}
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: '#FCEBC6', color: '#9A6206' }} title="No GPS ping in the last 5 min — auto-dispatch skips this rider; a targeted offer still works">
                        GPS stale
                      </span>
                    ))}
                    {busy === d.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: SUN.faint }} />
                      : <span className="text-[11px] capitalize" style={{ color: SUN.faint }}>{d.is_online ? d.vehicle_type : 'offline'}</span>}
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
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 20, x: '-50%' }}
      className="fixed bottom-5 left-1/2 z-40 flex items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-sm"
      style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}`, color: SUN.text, boxShadow: '0 8px 24px rgba(0,0,0,.16)' }}
    >
      <span>{text}</span>
      {onUndo ? (
        <button onClick={onUndo} className="flex items-center gap-1 font-medium" style={{ color: SUN.accent }}><Undo2 className="h-4 w-4" />Undo</button>
      ) : (
        <button onClick={onClose} aria-label="Dismiss" style={{ color: SUN.faint }}><X className="h-4 w-4" /></button>
      )}
    </motion.div>
  );
}

function ScheduledDrawer({ orders, now, onClose }: { orders: Order[]; now: number; onClose: () => void }) {
  return (
    <motion.div className="fixed inset-0 z-40 flex justify-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} style={{ background: 'rgba(0,0,0,.35)' }}>
      <motion.div
        initial={{ x: 360 }} animate={{ x: 0 }} exit={{ x: 360 }} transition={{ ease: 'easeOut', duration: 0.3 }}
        onClick={(e) => e.stopPropagation()} className="flex h-full w-[340px] flex-col" style={{ background: SUN.page }}
      >
        <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ background: SUN.header }}>
          <CalendarClock className="h-5 w-5" /><h2 className="text-[15px] font-semibold">Scheduled · {orders.length}</h2>
          <button onClick={onClose} aria-label="Close" className="ml-auto"><X className="h-5 w-5" /></button>
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
                      Releases in {mins}m
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

function beep(freq: number) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch { /* autoplay may be blocked until first interaction */ }
}
