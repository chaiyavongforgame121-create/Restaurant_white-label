'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import {
  Check,
  Copy,
  Download,
  Pencil,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { TABLE_TYPES, tableTypeLabel } from '@favornoms/database/queries';
import { Badge, Button, Card, EmptyState, IconButton, useConfirm } from '@favornoms/ui';
import { tableMenuLink } from '../../_lib/menu-url';

export interface BranchTable {
  id: string;
  table_number: string;
  display_name: string | null;
  capacity: number | null;
  zone: string | null;
  /** booth / bar / high top / private room / …. `shape` is the floor-plan glyph, not this. */
  table_type: string;
  /** table_number is text, so this is what actually puts 2 before 10. */
  sort_order: number;
  /** 'open' | 'occupied' | 'dirty' | 'reserved' — written by the floor board. */
  status: string | null;
  is_active: boolean;
  /** Nullable in the generated types until the token migration is applied. */
  qr_code_token: string | null;
}

interface Props {
  branchId: string;
  branchName: string;
  restaurantName: string;
  /** Null when the branch has neither a custom domain nor a slug pair. */
  menuUrl: string | null;
  missingSlugs: string[];
  initialTables: BranchTable[];
}

const SELECT =
  'id, table_number, display_name, capacity, zone, table_type, sort_order, status, is_active, qr_code_token';

/** The digits in "T12" are what a floor means by "twelfth table". Mirrors the migration's backfill. */
const digitsOf = (value: string) => Number(value.replace(/\D/g, '')) || 0;

/** Print resolution for a downloaded code — big enough for a table tent. */
const PNG_SIZE = 1024;

/** How many tables the one-tap starter creates. */
const BULK_COUNT = 20;

/**
 * The table's name as printed on its tent (and in the PNG's file name). The printed sheet has
 * no language of its own, so this stays English; the screen uses `screenLabel` instead.
 */
const labelFor = (t: BranchTable) => t.display_name?.trim() || `Table ${t.table_number}`;

const fileSlug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'table';

const KNOWN_TABLE_TYPES: readonly string[] = TABLE_TYPES;

type TableErrorCode = 'duplicateNumber' | 'hasOrders' | 'tableNotFound' | 'notPermitted' | 'generic';

/** Database failures as codes; anything unrecognised is logged and shown as a generic message. */
function tableErrorCode(err: { message: string; code?: string }): TableErrorCode {
  if (err.message.includes('tables_branch_id_table_number_key')) return 'duplicateNumber';
  if (err.code === '23503') return 'hasOrders';
  if (err.message.includes('table_not_found')) return 'tableNotFound';
  if (err.message.includes('not_permitted') || err.code === '42501') return 'notPermitted';
  console.error(err.message);
  return 'generic';
}

export function TableQrManager({
  branchId,
  branchName,
  restaurantName,
  menuUrl,
  missingSlugs,
  initialTables,
}: Props) {
  const tr = useTranslations('qr');
  const tt = useTranslations('tables');
  const [list, setList] = React.useState(initialTables);
  const [composing, setComposing] = React.useState(false);
  const [tableNumber, setTableNumber] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [capacity, setCapacity] = React.useState('');
  const [zone, setZone] = React.useState('');
  const [tableType, setTableType] = React.useState<string>('standard');
  const [sortOrder, setSortOrder] = React.useState('');
  /** The table being edited, or null when the form is composing a new one. */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  // One off-screen high-res canvas, mounted only for the table being saved. Twenty
  // 1024px canvases painted up-front is megabytes of idle bitmap on a floor of tables.
  const [pngTarget, setPngTarget] = React.useState<BranchTable | null>(null);
  const pngCanvasRef = React.useRef<HTMLCanvasElement>(null);
  const confirm = useConfirm();

  const active = list.filter((t) => t.is_active);
  const retired = list.filter((t) => !t.is_active);

  /** The table's name in the viewer's language, for everything that is not printed. */
  const screenLabel = (t: BranchTable) =>
    t.display_name?.trim() || tr('tables.tableLabel', { number: t.table_number });

  const typeLabel = (value: string) =>
    tt(`types.${KNOWN_TABLE_TYPES.includes(value) ? value : 'standard'}`);

  const describe = (err: { message: string; code?: string }) =>
    tr(`tables.errors.${tableErrorCode(err)}`);

  const linkFor = (t: BranchTable) =>
    menuUrl && t.qr_code_token ? tableMenuLink(menuUrl, t.qr_code_token) : null;

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('tables')
      .select(SELECT)
      .eq('branch_id', branchId)
      // sort_order first, because table_number is text: on its own it puts 10 before 2.
      .order('sort_order')
      .order('table_number');
    if (data) setList(data as unknown as BranchTable[]);
  };

  const resetForm = () => {
    setTableNumber('');
    setDisplayName('');
    setCapacity('');
    setZone('');
    setTableType('standard');
    setSortOrder('');
    setEditingId(null);
    setComposing(false);
  };

  const startEdit = (t: BranchTable) => {
    setEditingId(t.id);
    setComposing(false);
    setError(null);
    setTableNumber(t.table_number);
    setDisplayName(t.display_name ?? '');
    setCapacity(t.capacity ? String(t.capacity) : '');
    setZone(t.zone ?? '');
    setTableType(t.table_type || 'standard');
    setSortOrder(t.sort_order ? String(t.sort_order) : '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** The fields both Add and Edit write. Sort order defaults to the digits in the number. */
  const formValues = () => ({
    table_number: tableNumber.trim(),
    display_name: displayName.trim() || null,
    capacity: capacity ? Number(capacity) : null,
    zone: zone.trim() || null,
    table_type: tableType,
    sort_order: sortOrder ? Number(sortOrder) : digitsOf(tableNumber),
  });

  const create = async () => {
    const number = tableNumber.trim();
    if (!number) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase
      .from('tables')
      .insert({ branch_id: branchId, ...formValues() });
    setBusy(false);
    if (insErr) {
      setError(describe(insErr));
      return;
    }
    resetForm();
    void refresh();
  };

  // Every field except the code itself. A table gets renamed, re-zoned and re-seated over
  // its life, and the only way to do any of that used to be delete-and-recreate — which
  // destroys the token and every printed tent standing on the floor.
  const saveEdit = async () => {
    if (!editingId || !tableNumber.trim()) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: updErr } = await supabase
      .from('tables')
      .update(formValues())
      .eq('id', editingId);
    setBusy(false);
    if (updErr) {
      setError(describe(updErr));
      return;
    }
    resetForm();
    void refresh();
  };

  const bulkCreate = async () => {
    setBusy(true);
    setError(null);
    const taken = new Set(list.map((t) => t.table_number));
    const rows = Array.from({ length: BULK_COUNT }, (_, i) => String(i + 1))
      .filter((n) => !taken.has(n))
      .map((n) => ({ branch_id: branchId, table_number: n, sort_order: Number(n) }));
    if (rows.length === 0) {
      setBusy(false);
      return;
    }
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('tables').insert(rows);
    setBusy(false);
    if (insErr) {
      setError(describe(insErr));
      return;
    }
    void refresh();
  };

  const toggleActive = async (t: BranchTable) => {
    const supabase = getBrowserClient();
    const { error: updErr } = await supabase
      .from('tables')
      .update({ is_active: !t.is_active })
      .eq('id', t.id);
    if (updErr) {
      setError(describe(updErr));
      return;
    }
    void refresh();
  };

  const rotate = async (t: BranchTable) => {
    if (
      !(await confirm({
        title: tr('tables.rotateConfirm.title', { table: screenLabel(t) }),
        body: tr('tables.rotateConfirm.body'),
        confirmLabel: tr('tables.rotateConfirm.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    // Not in the generated types yet — same thin escape the other new RPCs use.
    const { error: rpcErr } = await supabase.rpc('rotate_table_qr_token', {
      p_table_id: t.id,
    } as never);
    if (rpcErr) {
      setError(describe(rpcErr));
      return;
    }
    void refresh();
  };

  const remove = async (t: BranchTable) => {
    if (
      !(await confirm({
        title: tr('tables.deleteConfirm.title', { table: screenLabel(t) }),
        body: tr('tables.deleteConfirm.body'),
        confirmLabel: tr('tables.deleteConfirm.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    const { error: delErr } = await supabase.from('tables').delete().eq('id', t.id);
    if (delErr) {
      setError(describe(delErr));
      return;
    }
    void refresh();
  };

  const copy = async (t: BranchTable) => {
    const link = linkFor(t);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(t.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // ignore — clipboard may be unavailable
    }
  };

  // The hidden canvas is a child, so its own paint effect has already run by the time
  // this one does; reading it any earlier would download a blank square.
  React.useEffect(() => {
    if (!pngTarget) return;
    const canvas = pngCanvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `qr-${fileSlug(branchName)}-${fileSlug(labelFor(pngTarget))}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setPngTarget(null);
  }, [pngTarget, branchName]);

  const pngLink = pngTarget ? linkFor(pngTarget) : null;

  if (!menuUrl) {
    const missing =
      missingSlugs.length === 2 ? 'both' : missingSlugs[0] === 'restaurant' ? 'restaurant' : 'branch';
    return (
      <div className="container max-w-xl py-8">
        <h1 className="font-display text-2xl font-bold">{tr('tables.title')}</h1>
        <Card className="mt-5 p-6">
          <h2 className="font-display text-lg font-semibold">{tr('noLink.title')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr.rich(`noLink.tableBody.${missing}`, {
              code: (chunks) => (
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{chunks}</code>
              ),
            })}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr.rich('noLink.tableHelp', { strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
          <div className="mt-4">
            <Link href={`/b/${branchId}/branch`}>
              <Button variant="outline" leftIcon={<Settings2 className="h-4 w-4" />}>
                {tr('noLink.openBranchSettings')}
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-5xl py-8">
      <header className="no-print mb-6 flex flex-wrap items-end justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{tr('tables.title')}</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            {tr('tables.intro', { branch: branchName })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {active.length > 0 && (
            <Button
              variant="outline"
              leftIcon={<Printer className="h-4 w-4" />}
              onClick={() => window.print()}
            >
              {tr('tables.printSheet')}
            </Button>
          )}
          <Button
            variant={composing || editingId ? 'ghost' : 'gradient'}
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => {
              if (composing || editingId) resetForm();
              else setComposing(true);
            }}
          >
            {composing || editingId ? tr('tables.cancel') : tr('tables.addTable')}
          </Button>
        </div>
      </header>

      {(composing || editingId) && (
        <Card className="no-print mb-6 space-y-3 p-5">
          {editingId && (
            <p className="text-sm text-muted-foreground">{tr('tables.editingNote')}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr('tables.fields.tableNumber')}>
              <input
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                className="input"
                placeholder="7"
                inputMode="numeric"
              />
            </Field>
            <Field label={tr('tables.fields.name')}>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input"
                placeholder={tr('tables.fields.namePlaceholder')}
              />
            </Field>
            <Field label={tr('tables.fields.type')}>
              <select
                value={tableType}
                onChange={(e) => setTableType(e.target.value)}
                className="input"
              >
                {TABLE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {typeLabel(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={tr('tables.fields.seats')}>
              <input
                value={capacity}
                onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ''))}
                className="input"
                inputMode="numeric"
                placeholder="4"
              />
            </Field>
            <Field label={tr('tables.fields.zone')}>
              <input
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                className="input"
                placeholder={tr('tables.fields.zonePlaceholder')}
              />
            </Field>
            <Field label={tr('tables.fields.sortOrder')}>
              <input
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ''))}
                className="input"
                inputMode="numeric"
                placeholder={String(digitsOf(tableNumber) || 1)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{tr('tables.sortHint')}</p>
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <Button
            variant="gradient"
            onClick={editingId ? saveEdit : create}
            disabled={!tableNumber.trim()}
            loading={busy}
          >
            {editingId ? tr('tables.saveChanges') : tr('tables.addTable')}
          </Button>
        </Card>
      )}

      {!composing && !editingId && error && (
        <p role="alert" className="no-print mb-4 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {list.length === 0 ? (
        <div className="no-print">
          <EmptyState
            icon={<QrCode className="h-7 w-7" />}
            title={tr('tables.empty.title')}
            description={tr('tables.empty.description')}
            action={
              <Button variant="gradient" onClick={bulkCreate} loading={busy}>
                {tr('tables.empty.bulk', { count: BULK_COUNT })}
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div
            id="table-qr-sheet"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            {active.map((t) => {
              const link = linkFor(t);
              return (
                <Card key={t.id} className="flex flex-col items-center gap-3 p-5 text-center">
                  <div className="rounded-2xl bg-white p-4 shadow-soft">
                    {link ? (
                      <QRCodeSVG value={link} size={160} level="M" marginSize={2} />
                    ) : (
                      <div className="grid h-[160px] w-[160px] place-items-center text-xs text-muted-foreground">
                        {tr('tables.codePending')}
                      </div>
                    )}
                  </div>
                  {/* What diners read on the printed tent. The print has no language of its
                      own, so these words stay English. */}
                  <div>
                    <p className="font-display text-xl font-bold">{labelFor(t)}</p>
                    <p className="text-sm text-muted-foreground">
                      Scan to order · {restaurantName || branchName}
                    </p>
                    {(t.zone || t.capacity || t.table_type !== 'standard') && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {[
                          t.zone,
                          t.table_type && t.table_type !== 'standard'
                            ? tableTypeLabel(t.table_type)
                            : null,
                          t.capacity ? `${t.capacity} seats` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                  <div className="no-print flex w-full flex-wrap items-center justify-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!link}
                      leftIcon={
                        copiedId === t.id ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )
                      }
                      onClick={() => void copy(t)}
                    >
                      {copiedId === t.id ? tr('actions.copied') : tr('actions.copyLink')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!link}
                      leftIcon={<Download className="h-4 w-4" />}
                      onClick={() => setPngTarget(t)}
                    >
                      PNG
                    </Button>
                    <IconButton label={tr('tables.editTable')} size="sm" onClick={() => startEdit(t)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={tr('tables.rotate')} size="sm" onClick={() => void rotate(t)}>
                      <RefreshCw className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={tr('tables.deleteTable')}
                      size="sm"
                      className="text-danger"
                      onClick={() => void remove(t)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggleActive(t)}
                    className="no-print text-xs text-muted-foreground underline"
                  >
                    {tr('tables.turnOff')}
                  </button>
                </Card>
              );
            })}
          </div>

          {retired.length > 0 && (
            <Card className="no-print mt-6 divide-y divide-border/40">
              <div className="p-4">
                <h2 className="font-display text-lg font-semibold">{tr('tables.retired.title')}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {tr('tables.retired.description')}
                </p>
              </div>
              {retired.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-semibold">{screenLabel(t)}</p>
                    {t.zone && <p className="text-xs text-muted-foreground">{t.zone}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="muted">{tr('tables.retired.badge')}</Badge>
                    <button
                      type="button"
                      onClick={() => void toggleActive(t)}
                      className="text-xs text-muted-foreground underline"
                    >
                      {tr('tables.turnOn')}
                    </button>
                    <IconButton
                      label={tr('tables.deleteTable')}
                      size="sm"
                      className="text-danger"
                      onClick={() => void remove(t)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </div>
              ))}
            </Card>
          )}

          <p className="no-print mt-6 text-center text-xs text-muted-foreground">
            {tr('tables.footer', { size: PNG_SIZE })}
          </p>
        </>
      )}

      {pngTarget && pngLink && (
        <QRCodeCanvas
          ref={pngCanvasRef}
          value={pngLink}
          size={PNG_SIZE}
          level="M"
          marginSize={2}
          className="hidden"
          aria-hidden
        />
      )}

      <style jsx>{`
        .input {
          width: 100%;
          min-height: 48px;
          padding: 0 1rem;
          font-size: 16px;
          border-radius: 0.875rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
        }
        .input:focus-visible {
          outline: none;
          border-color: hsl(var(--primary));
          box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
        }
      `}</style>

      {/* The sheet is what gets printed: sidebar, toolbars and per-card actions all go,
          and each card is kept whole so a code is never cut in half by a page break. */}
      <style jsx global>{`
        @media print {
          aside {
            display: none !important;
          }
          .no-print {
            display: none !important;
          }
          #table-qr-sheet {
            display: grid !important;
            grid-template-columns: repeat(2, 1fr) !important;
            gap: 0 !important;
          }
          #table-qr-sheet > * {
            break-inside: avoid;
            page-break-inside: avoid;
            border: none;
            box-shadow: none;
          }
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
