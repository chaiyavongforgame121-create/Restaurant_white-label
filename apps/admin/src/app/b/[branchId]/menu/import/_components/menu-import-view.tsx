'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import type { MenuCategory } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { getSupabaseEnv } from '@favornoms/database/env';
import { Badge, Button, Card, IconButton } from '@favornoms/ui';
import { CsvImportCard } from './csv-import-card';

interface ProposedItem {
  category: string;
  name: string;
  description?: string;
  price: number;
  station?: 'hot' | 'cold' | 'bar' | 'dessert' | 'expo';
  _accepted?: boolean;
}

export function MenuImportView({
  branchId,
  categories,
}: {
  branchId: string;
  categories: MenuCategory[];
}) {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const [hint, setHint] = React.useState('');
  const [items, setItems] = React.useState<ProposedItem[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedCount, setSavedCount] = React.useState<number | null>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setItems([]);
    setSavedCount(null);
    try {
      const supabase = getBrowserClient();
      const path = `imports/${branchId}/${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
      const { error: upErr } = await supabase.storage.from('branch-assets').upload(path, file, {
        upsert: false,
        contentType: file.type,
      });
      if (upErr) throw new Error(upErr.message);
      const { data: pub } = supabase.storage.from('branch-assets').getPublicUrl(path);
      setImageUrl(pub.publicUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const analyze = async () => {
    if (!imageUrl) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error('not_signed_in');

      const { url } = getSupabaseEnv();
      const res = await fetch(`${url}/functions/v1/import-menu`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ image_url: imageUrl, branch_id: branchId, hint }),
      });
      const body = (await res.json()) as { items?: ProposedItem[]; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `http_${res.status}`);
      setItems((body.items ?? []).map((i) => ({ ...i, _accepted: true })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importAccepted = async () => {
    const accepted = items.filter((i) => i._accepted);
    if (accepted.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const catMap = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
      const newCatNames = new Set<string>();
      for (const item of accepted) {
        if (!catMap.has(item.category.toLowerCase())) newCatNames.add(item.category);
      }
      for (const catName of newCatNames) {
        const { data: created } = await supabase
          .from('menu_categories')
          .insert({ branch_id: branchId, name: catName, display_order: 999 })
          .select('id, name')
          .single();
        if (created) catMap.set(created.name.toLowerCase(), created.id);
      }

      const rows = accepted.map((i, idx) => ({
        branch_id: branchId,
        category_id: catMap.get(i.category.toLowerCase())!,
        name: i.name,
        description: i.description ?? null,
        price: i.price,
        station: i.station ?? 'expo',
        is_active: true,
        display_order: idx,
      }));
      const { error: insErr, count } = await supabase
        .from('menu_items')
        .insert(rows, { count: 'exact' });
      if (insErr) throw new Error(insErr.message);
      setSavedCount(count ?? rows.length);
      setItems([]);
      setImageUrl(null);
      setFile(null);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Import menu with AI</h1>
        <p className="mt-1 text-muted-foreground">
          Upload a photo of a printed menu — Claude extracts items, prices, and categories for review.
        </p>
      </header>

      <Card className="mb-6 space-y-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1.5 block text-sm font-medium">Menu image</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-primary file:px-4 file:py-2.5 file:text-primary-foreground"
            />
          </label>
          <Button
            variant="gradient"
            onClick={upload}
            disabled={!file || busy}
            loading={busy && !!file && !imageUrl}
            leftIcon={<Upload className="h-4 w-4" />}
          >
            Upload
          </Button>
        </div>

        <label>
          <span className="mb-1.5 block text-sm font-medium">Hint to AI (optional)</span>
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="e.g. American casual, prices in USD"
            className="input"
          />
        </label>

        {imageUrl && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Image uploaded. Click Analyze to extract menu items.
            </p>
            <Button
              variant="gradient"
              onClick={analyze}
              disabled={busy}
              loading={busy && items.length === 0}
              leftIcon={<Sparkles className="h-4 w-4" />}
            >
              Analyze with AI
            </Button>
          </div>
        )}

        {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {savedCount !== null && (
          <p className="rounded-xl bg-success/10 px-4 py-3 text-sm text-success">
            Imported {savedCount} item{savedCount === 1 ? '' : 's'}.
          </p>
        )}

        <style jsx>{`
          .input {
            width: 100%;
            height: 48px;
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
      </Card>

      {/* CSV import — alternative for users who already have a spreadsheet */}
      <CsvImportCard
        branchId={branchId}
        categories={categories}
        onImported={(n) => {
          setSavedCount(n);
          router.refresh();
        }}
      />

      {items.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">
              {items.filter((i) => i._accepted).length} of {items.length} items selected
            </h2>
            <Button
              variant="gradient"
              onClick={importAccepted}
              disabled={busy || items.filter((i) => i._accepted).length === 0}
              loading={busy}
              leftIcon={<Check className="h-4 w-4" />}
            >
              Import selected
            </Button>
          </div>

          <Card className="divide-y divide-border/40">
            {items.map((item, idx) => (
              <div key={idx} className="flex items-start gap-3 p-3">
                <input
                  type="checkbox"
                  checked={!!item._accepted}
                  onChange={(e) =>
                    setItems((curr) =>
                      curr.map((it, i) => (i === idx ? { ...it, _accepted: e.target.checked } : it)),
                    )
                  }
                  className="mt-1.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <input
                      value={item.name}
                      onChange={(e) =>
                        setItems((curr) =>
                          curr.map((it, i) => (i === idx ? { ...it, name: e.target.value } : it)),
                        )
                      }
                      className="flex-1 bg-transparent font-medium outline-none"
                    />
                    <input
                      type="number"
                      value={item.price}
                      onChange={(e) =>
                        setItems((curr) =>
                          curr.map((it, i) =>
                            i === idx ? { ...it, price: Number(e.target.value) } : it,
                          ),
                        )
                      }
                      className="w-24 bg-transparent text-right font-display font-bold text-primary outline-none"
                    />
                  </div>
                  <input
                    value={item.description ?? ''}
                    onChange={(e) =>
                      setItems((curr) =>
                        curr.map((it, i) =>
                          i === idx ? { ...it, description: e.target.value } : it,
                        ),
                      )
                    }
                    placeholder="Description"
                    className="w-full bg-transparent text-sm text-muted-foreground outline-none"
                  />
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="muted">{item.category}</Badge>
                    {item.station && <Badge variant="muted">{item.station}</Badge>}
                  </div>
                </div>
                <IconButton
                  label="Remove"
                  size="sm"
                  className="text-danger"
                  onClick={() =>
                    setItems((curr) => curr.filter((_, i) => i !== idx))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            ))}
          </Card>
        </div>
      )}

      {busy && items.length === 0 && imageUrl && (
        <Card className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Analyzing image with Claude…
        </Card>
      )}
    </div>
  );
}
