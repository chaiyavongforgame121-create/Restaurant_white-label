'use client';

import * as React from 'react';
import Link from 'next/link';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Download, Printer, Settings2 } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

interface Props {
  url: string | null;
  branchId: string;
  branchName: string;
  restaurantName: string;
  /** Which slug(s) are empty — drives the "fix exactly this" message. */
  missingSlugs?: string[];
}

/** Print resolution for the downloaded PNG — big enough for a table tent. */
const PNG_SIZE = 1024;

export function BranchQr({ url, branchId, branchName, restaurantName, missingSlugs = [] }: Props) {
  const [copied, setCopied] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  if (!url) {
    const what =
      missingSlugs.length === 2
        ? 'This restaurant and this branch have no URL slug'
        : missingSlugs[0] === 'restaurant'
          ? 'This restaurant has no URL slug'
          : 'This branch has no URL slug';
    return (
      <div className="container max-w-xl py-8">
        <h1 className="font-display text-2xl font-bold">Branch QR code</h1>
        <Card className="mt-5 p-6">
          <h2 className="font-display text-lg font-semibold">Can&apos;t build a menu link yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {what}, so there is no public address to point a QR code at. A slug is the short
            name in your menu link, e.g.{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/r/coastal-grill/brooklyn</code>.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Slugs are created during onboarding. If yours is blank, set a{' '}
            <strong>custom domain</strong> in Branch settings instead — that also gives this
            branch a scannable address — or ask support to fill the slug in.
          </p>
          <div className="mt-4">
            <Link href={`/b/${branchId}/branch`}>
              <Button variant="outline" leftIcon={<Settings2 className="h-4 w-4" />}>
                Open Branch settings
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
      <h1 className="font-display text-2xl font-bold">Branch QR code</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Print this and place it on tables or at the counter. Guests scan it to open {branchName}&apos;s
        menu and order from their phone.
      </p>

      <Card className="mt-5 p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-2xl bg-white p-5 shadow-soft">
            <QRCodeSVG value={url} size={240} level="M" marginSize={2} />
          </div>
          <div>
            <p className="font-display text-xl font-bold">{restaurantName || branchName}</p>
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
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button
            variant="outline"
            fullWidth
            leftIcon={<Download className="h-4 w-4" />}
            onClick={downloadPng}
          >
            Download PNG
          </Button>
          <Button
            variant="gradient"
            fullWidth
            leftIcon={<Printer className="h-4 w-4" />}
            onClick={() => window.print()}
          >
            Print
          </Button>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          PNG is {PNG_SIZE}×{PNG_SIZE}px — big enough for table tents and posters.
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
