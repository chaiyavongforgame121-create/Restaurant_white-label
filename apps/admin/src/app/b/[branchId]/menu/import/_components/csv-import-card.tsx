'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { FileSpreadsheet, Upload } from 'lucide-react';
import type { MenuCategory } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { createKitchenStation, listKitchenStations } from '@favornoms/database/queries';
import { Badge, Button, Card } from '@favornoms/ui';
import type { BuiltInStationKey, KitchenStation } from '@/lib/kitchen-stations';
import { csvStationMatcher, newStationNames, stationNameTooLong, STATION_NAME_MAX } from './csv-stations';

/** A row problem as a code; the sentence is translated where it is shown. */
type RowError =
  | { code: 'missingCategory' | 'missingName' }
  | { code: 'invalidPrice'; value: string }
  | { code: 'stationTooLong'; value: string };

interface ParsedRow {
  category: string;
  name: string;
  description?: string;
  price: number;
  /** The cell as written, trimmed; matched against the branch's stations on import. */
  station?: string;
  error?: RowError;
}

// CSV column names are a data format: they stay English in every interface language.
const HEADER_ALIASES: Record<string, string> = {
  category: 'category',
  cat: 'category',
  name: 'name',
  item: 'name',
  description: 'description',
  desc: 'description',
  price: 'price',
  cost: 'price',
  station: 'station',
};

const CSV_COLUMNS = 'category, name, description, price, station';

type DbErrorKey = 'permissionDenied' | 'network' | 'duplicate' | 'inUse' | 'invalidValue' | 'generic';

/** Raw PostgREST text never reaches the merchant: known codes get a translated sentence. */
function dbErrorKey(err: { code?: string; message?: string }): DbErrorKey {
  const message = err.message ?? '';
  if (err.code === '42501' || /row-level security|permission denied/i.test(message)) return 'permissionDenied';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'network';
  if (err.code === '23505') return 'duplicate';
  if (err.code === '23503') return 'inUse';
  if (err.code && /^(22|23)/.test(err.code)) return 'invalidValue';
  return 'generic';
}

export function CsvImportCard({
  branchId,
  categories,
  stations,
  onImported,
}: {
  branchId: string;
  categories: MenuCategory[];
  /** The branch's kitchen stations as the page read them, for the preview of what an import adds. */
  stations: KitchenStation[];
  onImported: (count: number) => void;
}) {
  const t = useTranslations('menuExtras');
  // The built-in stations' labels live with the menu editor's, where the dish dialog shows them.
  const tMenu = useTranslations('menu');
  const builtInLabel = (key: BuiltInStationKey) => tMenu(`stations.${key}`);
  const [text, setText] = React.useState('');
  const [parsed, setParsed] = React.useState<ParsedRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    const raw = await file.text();
    setText(raw);
    setParsed(parseCsv(raw));
  };

  const onTextChange = (next: string) => {
    setText(next);
    setParsed(next.trim() ? parseCsv(next) : []);
  };

  const importRows = async () => {
    const valid = parsed.filter((r) => !r.error);
    if (valid.length === 0) {
      setError(t('import.csv.noValidRows'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      // Stations first, read afresh rather than from the page: one added or renamed in another tab
      // since must be matched, not added a second time (names are unique per branch). A station
      // that cannot be added stops the import before any category or dish is written, rather than
      // importing those dishes with no station.
      const current = await listKitchenStations(supabase, branchId);
      const created: KitchenStation[] = [];
      for (const stationName of newStationNames(
        valid.map((r) => r.station),
        csvStationMatcher(current, builtInLabel),
      )) {
        try {
          created.push(await createKitchenStation(supabase, branchId, stationName));
        } catch (err) {
          console.error('[menu-import] create station failed', err);
          setError(
            t('import.csv.stationCreateFailed', {
              name: stationName,
              reason: t(`errors.${dbErrorKey(err as { code?: string; message?: string })}`),
            }),
          );
          return;
        }
      }
      // Every cell now names a station the branch has, or none.
      const matchStation = csvStationMatcher([...current, ...created], builtInLabel);
      const stationKey = (cell: string | undefined) => {
        const match = matchStation(cell);
        return match.kind === 'station' ? match.key : null;
      };
      const catMap = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
      // Ensure all referenced categories exist
      const needCats = new Set<string>();
      for (const row of valid) {
        if (!catMap.has(row.category.toLowerCase())) needCats.add(row.category);
      }
      for (const catName of needCats) {
        const { data: created } = await supabase
          .from('menu_categories')
          .insert({ branch_id: branchId, name: catName, display_order: 999 })
          .select('id, name')
          .single();
        if (created) catMap.set(created.name.toLowerCase(), created.id);
      }
      const rows = valid.map((r, idx) => ({
        branch_id: branchId,
        category_id: catMap.get(r.category.toLowerCase())!,
        name: r.name,
        description: r.description ?? null,
        price: r.price,
        // A blank cell is no station: null, never '' and no longer expo.
        station: stationKey(r.station),
        is_active: true,
        display_order: idx,
      }));
      const { error: insErr, count } = await supabase
        .from('menu_items')
        .insert(rows, { count: 'exact' });
      if (insErr) {
        console.error('[menu-import] csv insert failed', insErr);
        setError(t(`errors.${dbErrorKey(insErr)}`));
        return;
      }
      onImported(count ?? rows.length);
      setText('');
      setParsed([]);
    } catch (err) {
      console.error('[menu-import] csv import failed', err);
      setError(t(`errors.${dbErrorKey({ message: (err as Error)?.message })}`));
    } finally {
      setBusy(false);
    }
  };

  const validCount = parsed.filter((r) => !r.error).length;
  const errorCount = parsed.length - validCount;
  const rowsWithErrors = parsed.filter((r) => r.error);
  // Said before the import, so a misspelt station is caught here rather than found on the board.
  const stationsToAdd = newStationNames(
    parsed.filter((r) => !r.error).map((r) => r.station),
    csvStationMatcher(stations, builtInLabel),
  );

  return (
    <Card className="space-y-4 p-5">
      <header className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
          <FileSpreadsheet className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h2 className="font-display text-lg font-semibold">{t('import.csv.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t.rich('import.csv.columns', {
              columns: CSV_COLUMNS,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          className="block text-sm file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-muted file:px-4 file:py-2 file:text-foreground"
        />
        <a
          href={'data:text/csv;charset=utf-8,' + encodeURIComponent(SAMPLE_CSV)}
          download="menu-template.csv"
          className="text-xs font-semibold text-primary underline"
        >
          {t('import.csv.downloadTemplate')}
        </a>
      </div>

      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={6}
        placeholder={SAMPLE_CSV}
        className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs"
      />

      {parsed.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="success">{t('import.csv.valid', { count: validCount })}</Badge>
            {errorCount > 0 && <Badge variant="danger">{t('import.csv.errorCount', { count: errorCount })}</Badge>}
          </div>
          {errorCount > 0 && (
            <ul className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {rowsWithErrors.slice(0, 5).map((r, i) => (
                <li key={i}>
                  {t(`import.csv.rowErrors.${r.error!.code}`, {
                    row: parsed.indexOf(r) + 1,
                    value: 'value' in r.error! ? r.error!.value : '',
                    max: STATION_NAME_MAX,
                  })}
                </li>
              ))}
              {rowsWithErrors.length > 5 && (
                <li>{t('import.csv.moreErrors', { count: rowsWithErrors.length - 5 })}</li>
              )}
            </ul>
          )}
          {stationsToAdd.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('import.csv.newStations', { count: stationsToAdd.length, names: stationsToAdd.join(', ') })}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <Button
        variant="gradient"
        onClick={importRows}
        loading={busy}
        disabled={validCount === 0 || busy}
        leftIcon={<Upload className="h-4 w-4" />}
      >
        {t('import.csv.import', { count: validCount })}
      </Button>
    </Card>
  );
}

function parseCsv(text: string): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsv(lines[0]!).map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim().toLowerCase());
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsv(lines[i]!);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    const price = Number(obj.price);
    const row: ParsedRow = {
      category: obj.category ?? '',
      name: obj.name ?? '',
      description: obj.description || undefined,
      price,
      // Any name, matched on import against the branch's stations, or added as a new one. It used
      // to be a fixed, case-sensitive list of codes, and anything else ("Hot") was dropped unsaid.
      station: obj.station || undefined,
    };
    if (!row.category) row.error = { code: 'missingCategory' };
    else if (!row.name) row.error = { code: 'missingName' };
    else if (!Number.isFinite(price) || price <= 0) row.error = { code: 'invalidPrice', value: obj.price ?? '' };
    else if (row.station && stationNameTooLong(row.station)) row.error = { code: 'stationTooLong', value: row.station };
    rows.push(row);
  }
  return rows;
}

// Simple CSV split that handles quoted strings. Avoids a dependency.
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Sample data in the CSV format — kept English on purpose (it is a file template, not interface text).
// Stations by the names the menu page shows; the last row has none.
const SAMPLE_CSV = `category,name,description,price,station
Burgers,Cheeseburger,Classic American cheeseburger,11.50,Hot
Burgers,Veggie Burger,Black-bean patty with chipotle mayo,12.95,Hot
Sides,Hand-cut fries,Sea-salted golden fries,4.95,Hot
Drinks,Cold brew,House cold brew with milk,4.50,Bar
Drinks,Sparkling water,Chilled 500 ml bottle,2.50,`;
