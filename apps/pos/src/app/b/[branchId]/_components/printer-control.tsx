'use client';

import * as React from 'react';
import { Printer, PrinterCheck, AlertCircle } from 'lucide-react';
import {
  EscPosBuilder,
  buildReceipt,
  getPairedPrinter,
  isWebUsbSupported,
  pairPrinter,
  printBytes,
  printReceiptViaBrowser,
  type PairedPrinter,
  type ReceiptInput,
} from '@favornoms/ui/printer';

interface PrinterControlContext {
  ready: boolean;
  vendor: string;
  pair: () => Promise<void>;
  print: (input: ReceiptInput) => Promise<void>;
  kickDrawer: () => Promise<void>;
}

const Ctx = React.createContext<PrinterControlContext | null>(null);

export function PrinterProvider({ children }: { children: React.ReactNode }) {
  const [printer, setPrinter] = React.useState<PairedPrinter | null>(null);
  const [vendor, setVendor] = React.useState<string>('');

  React.useEffect(() => {
    if (!isWebUsbSupported()) return;
    void (async () => {
      try {
        const dev = await getPairedPrinter();
        if (dev) {
          setPrinter(dev);
          // Type-cast — only exposing the productName field
          const name = (dev as unknown as { device: { productName?: string } }).device.productName;
          setVendor(name ?? 'USB Printer');
        }
      } catch {
        // ignore — user hasn't paired one yet
      }
    })();
  }, []);

  const pair = React.useCallback(async () => {
    const dev = await pairPrinter();
    setPrinter(dev);
    const name = (dev as unknown as { device: { productName?: string } }).device.productName;
    setVendor(name ?? 'USB Printer');
  }, []);

  const print = React.useCallback(
    async (input: ReceiptInput) => {
      if (printer) {
        try {
          await printBytes(printer, buildReceipt(input));
          return;
        } catch (err) {
          console.warn('USB print failed, falling back to browser', err);
        }
      }
      printReceiptViaBrowser(input);
    },
    [printer],
  );

  const kickDrawer = React.useCallback(async () => {
    if (!printer) return;
    try {
      const bytes = new EscPosBuilder().init().drawerKick().bytes();
      await printBytes(printer, bytes);
    } catch (err) {
      console.warn('Drawer kick failed', err);
    }
  }, [printer]);

  return (
    <Ctx.Provider value={{ ready: !!printer, vendor, pair, print, kickDrawer }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePrinter() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('usePrinter must be used inside <PrinterProvider>');
  return ctx;
}

export function PrinterStatusButton() {
  const { ready, vendor, pair } = usePrinter();
  const [busy, setBusy] = React.useState(false);

  if (!isWebUsbSupported()) {
    return (
      <button
        type="button"
        title="WebUSB not supported in this browser — will print via system dialog"
        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 text-xs font-semibold text-warning"
      >
        <AlertCircle className="h-3.5 w-3.5" />
        Browser print
      </button>
    );
  }

  const handleClick = async () => {
    setBusy(true);
    try {
      await pair();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'webusb_unsupported') alert(`Pairing failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  if (ready) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        title={`Connected: ${vendor}. Click to re-pair.`}
        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-3 text-xs font-semibold text-success"
      >
        <PrinterCheck className="h-3.5 w-3.5" />
        Printer ready
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground hover:border-primary"
    >
      <Printer className="h-3.5 w-3.5" />
      {busy ? 'Pairing…' : 'Pair printer'}
    </button>
  );
}
