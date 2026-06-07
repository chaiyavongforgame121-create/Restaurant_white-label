'use client';

import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Printer } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

interface Props {
  url: string | null;
  branchName: string;
  restaurantName: string;
}

export function BranchQr({ url, branchName, restaurantName }: Props) {
  const [copied, setCopied] = React.useState(false);

  if (!url) {
    return (
      <div className="container max-w-xl py-8">
        <Card className="p-6 text-center text-muted-foreground">
          This branch needs a URL slug before a QR code can be generated. Set one in Branch settings.
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
            <QRCodeSVG value={url} size={240} level="M" />
          </div>
          <div>
            <p className="font-display text-xl font-bold">{restaurantName || branchName}</p>
            <p className="text-sm text-muted-foreground">Scan to order · {branchName}</p>
          </div>
        </div>
        <p className="mt-4 break-all rounded-xl bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
          {url}
        </p>
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            fullWidth
            leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button variant="gradient" fullWidth leftIcon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </Card>

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
