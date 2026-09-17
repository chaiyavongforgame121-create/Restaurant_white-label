'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Download, Printer, QrCode, Settings2 } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

interface Props {
  url: string | null;
  branchId: string;
  branchName: string;
  restaurantName: string;
  /** Which slug(s) are empty — drives the "fix exactly this" message. */
  missingSlugs?: string[];
  /** Active tables with a code of their own, so this page can say what it is NOT for. */
  tableCount?: number;
}

/** Print resolution for the downloaded PNG — big enough for a table tent. */
const PNG_SIZE = 1024;

export function BranchQr({
  url,
  branchId,
  branchName,
  restaurantName,
  missingSlugs = [],
  tableCount = 0,
}: Props) {
  const t = useTranslations('qr');
  const [copied, setCopied] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  if (!url) {
    const missing =
      missingSlugs.length === 2 ? 'both' : missingSlugs[0] === 'restaurant' ? 'restaurant' : 'branch';
    return (
      <div className="container max-w-xl py-8">
        <h1 className="font-display text-2xl font-bold">{t('branch.title')}</h1>
        <Card className="mt-5 p-6">
          <h2 className="font-display text-lg font-semibold">{t('noLink.title')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.rich(`noLink.branchBody.${missing}`, {
              code: (chunks) => (
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{chunks}</code>
              ),
            })}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.rich('noLink.branchHelp', { strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
          <div className="mt-4">
            <Link href={`/b/${branchId}/branch`}>
              <Button variant="outline" leftIcon={<Settings2 className="h-4 w-4" />}>
                {t('noLink.openBranchSettings')}
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be unavailable
    }
  };

  const downloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `qr-${branchName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'branch'}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="container max-w-xl py-8">
      <h1 className="font-display text-2xl font-bold">{t('branch.title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {tableCount > 0
          ? t('branch.introWithTables', { branch: branchName })
          : t('branch.intro', { branch: branchName })}
      </p>

      {/* The two codes do different jobs and the difference is easy to miss, so the
          per-table one is offered here rather than left to the sidebar. */}
      <div className="mt-4 print:hidden">
        <Link href={`/b/${branchId}/qr/tables`}>
          <Button variant="outline" leftIcon={<QrCode className="h-4 w-4" />}>
            {tableCount > 0
              ? t('branch.tableCodes', { count: tableCount })
              : t('branch.setUpTableCodes')}
          </Button>
        </Link>
      </div>

      <Card className="mt-5 p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-2xl bg-white p-5 shadow-soft">
            <QRCodeSVG value={url} size={240} level="M" marginSize={2} />
          </div>
          <div>
            <p className="font-display text-xl font-bold">{restaurantName || branchName}</p>
            {/* Printed for diners, and the print has no language of its own: stays English. */}
            <p className="text-sm text-muted-foreground">Scan to order · {branchName}</p>
          </div>
        </div>
        <p className="mt-4 break-all rounded-xl bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
          {url}
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <Button
            variant="outline"
            fullWidth
            leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            onClick={copy}
          >
            {copied ? t('actions.copied') : t('actions.copyLink')}
          </Button>
          <Button
            variant="outline"
            fullWidth
            leftIcon={<Download className="h-4 w-4" />}
            onClick={downloadPng}
          >
            {t('branch.downloadPng')}
          </Button>
          <Button
            variant="gradient"
            fullWidth
            leftIcon={<Printer className="h-4 w-4" />}
            onClick={() => window.print()}
          >
            {t('branch.print')}
          </Button>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {t('branch.pngHint', { size: PNG_SIZE })}
        </p>
      </Card>

      {/* Off-screen high-res copy: the visible QR is an SVG, and a 240px canvas
          would download as a blurry sticker. Hidden, but still painted. */}
      <QRCodeCanvas
        ref={canvasRef}
        value={url}
        size={PNG_SIZE}
        level="M"
        marginSize={2}
        className="hidden"
        aria-hidden
      />

      <style jsx global>{`
        @media print {
          aside {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
