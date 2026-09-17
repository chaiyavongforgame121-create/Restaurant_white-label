'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Download, FileText, Printer } from 'lucide-react';
import { DEFAULT_UI_LOCALE, formatCurrency, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, useAlert } from '@favornoms/ui';

interface ReceiptRow {
  id: string;
  invoice_number: string;
  buyer_name: string | null;
  total: number | string;
  status: string;
  issued_at: string | null;
  order_id: string | null;
  orders?: { order_number?: string } | null;
}

interface Props {
  branchId: string;
  receipts: ReceiptRow[];
}

/** Receipt statuses the catalogue can name. Anything else is shown as stored. */
const KNOWN_STATUSES = ['issued', 'draft', 'pending', 'canceled', 'cancelled', 'void', 'voided'] as const;
type KnownStatus = (typeof KNOWN_STATUSES)[number];
const isKnownStatus = (s: string): s is KnownStatus =>
  (KNOWN_STATUSES as readonly string[]).includes(s);

export function ReceiptsList({ branchId, receipts }: Props) {
  const t = useTranslations('misc');
  const locale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const notify = useAlert();

  const openReceipt = async (id: string) => {
    setBusyId(id);
    try {
      const supabase = getBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const apikey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      const res = await fetch(`${url}/functions/v1/issue-tax-invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: apikey ?? '',
          Authorization: `Bearer ${accessToken ?? apikey}`,
        },
        body: JSON.stringify({ tax_invoice_id: id }),
      });
      if (!res.ok) {
        await notify({
          title: t('receipts.openFailedTitle'),
          body: t('receipts.openFailedBody', { status: String(res.status) }),
        });
        return;
      }
      const data = await res.json();
      const w = window.open('', '_blank', 'width=520,height=720');
      if (!w) {
        await notify({
          title: t('receipts.popupTitle'),
          body: t('receipts.popupBody'),
        });
        return;
      }
      // The receipt document itself is printed English (thermal printers cannot print Thai
      // or Vietnamese); only this screen follows the interface language.
      w.document.open();
      w.document.write(data.html);
      w.document.close();
      setTimeout(() => w.focus(), 50);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('receipts.title')}</h1>
        <p className="mt-1 text-muted-foreground">
          {t('receipts.subtitle', { branch: branchId.slice(0, 8) })}
        </p>
      </header>

      {receipts.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <FileText className="mx-auto h-10 w-10 opacity-40" />
          <p className="mt-3 text-sm">{t('receipts.empty')}</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">{t('receipts.columns.receipt')}</th>
                <th className="px-4 py-3 text-left font-semibold">{t('receipts.columns.order')}</th>
                <th className="px-4 py-3 text-left font-semibold">{t('receipts.columns.customer')}</th>
                <th className="px-4 py-3 text-right font-semibold">{t('receipts.columns.total')}</th>
                <th className="px-4 py-3 text-center font-semibold">{t('receipts.columns.status')}</th>
                <th className="px-4 py-3 text-left font-semibold">{t('receipts.columns.issued')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="px-4 py-3 font-medium">{r.invoice_number}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.orders?.order_number ?? '—'}</td>
                  <td className="px-4 py-3">{r.buyer_name ?? t('receipts.walkIn')}</td>
                  <td className="px-4 py-3 text-right font-display font-bold tabular-nums text-primary">
                    {formatCurrency(Number(r.total))}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant={r.status === 'issued' ? 'success' : 'muted'}>
                      {isKnownStatus(r.status) ? t(`receipts.status.${r.status}`) : r.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.issued_at ? new Date(r.issued_at).toLocaleString(intlLocale) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openReceipt(r.id)}
                      loading={busyId === r.id}
                      leftIcon={<Printer className="h-4 w-4" />}
                    >
                      {t('receipts.viewPrint')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}
