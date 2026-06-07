'use client';

import * as React from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import type { MenuCategory } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface ParsedRow {
  category: string;
  name: string;
  description?: string;
  price: number;
  station?: string;
  error?: string;
}

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

const VALID_STATIONS = ['hot', 'cold', 'bar', 'dessert', 'expo'];

export function CsvImportCard({
  branchId,
  categories,
  onImported,
}: {
  branchId: string;
  categories: MenuCategory[];
  onImported: (count: number) => void;
}) {
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
      setError('No valid rows to import.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
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
        station: r.station ?? 'expo',
        is_active: true,
        display_order: idx,
      }));
      const { error: insErr, count } = await supabase
        .from('menu_items')
        .insert(rows, { count: 'exact' });
      if (insErr) throw new Error(insErr.message);
      onImported(count ?? rows.length);
      setText('');
      setParsed([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const validCount = parsed.filter((r) => !r.error).length;
  const errorCount = parsed.length - validCount;

  return (
    <Card className="mt-6 space-y-4 p-5">
      <header className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
          <FileSpreadsheet className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h2 className="font-display text-lg font-semibold">CSV bulk import</h2>
          <p className="text-xs text-muted-foreground">
            Columns: <code>category, name, description, price, station</code> (station optional). First row must be headers.
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
          Download template
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
            <Badge variant="success">{validCount} valid</Badge>
            {errorCount > 0 && <Badge variant="danger">{errorCount} errors</Badge>}
          </div>
          {errorCount > 0 && (
            <ul className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {parsed.filter((r) => r.error).slice(0, 5).map((r, i) => (
                <li key={i}>
                  Row {parsed.indexOf(r) + 1}: {r.error}
                </li>
              ))}
              {parsed.filter((r) => r.error).length > 5 && (
                <li>… and {parsed.filter((r) => r.error).length - 5} more.</li>
              )}
            </ul>
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
        Import {validCount} item{validCount === 1 ? '' : 's'}
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
      station: obj.station && VALID_STATIONS.includes(obj.station) ? obj.station : undefined,
    };
    if (!row.category) row.error = 'missing category';
    else if (!row.name) row.error = 'missing name';
    else if (!Number.isFinite(price) || price <= 0) row.error = `invalid price "${obj.price}"`;
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

const SAMPLE_CSV = `category,name,description,price,station
Burgers,Cheeseburger,Classic American cheeseburger,11.50,hot
Burgers,Veggie Burger,Black-bean patty with chipotle mayo,12.95,hot
Sides,Hand-cut fries,Sea-salted golden fries,4.95,hot
Drinks,Cold brew,House cold brew with milk,4.50,bar`;
