'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Printer, PrinterCheck, AlertCircle } from 'lucide-react';
import { useAlert } from '@favornoms/ui';
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
          // Empty when the device reports no product name: the button names it "USB Printer"
          // in the language on screen.
          setVendor(name ?? '');
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
    setVendor(name ?? '');
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

/** WebUSB support never changes while the page is open. */
const subscribeNever = () => () => {};

export function PrinterStatusButton() {
  const t = useTranslations('counter');
  const { ready, vendor, pair } = usePrinter();
  const [busy, setBusy] = React.useState(false);
  const notify = useAlert();
  // null on the server and while hydrating: only the browser knows whether it has WebUSB, and
  // reading navigator during render made the server's "Browser print" and Chrome's "Pair printer"
  // disagree, so React threw the page's HTML away.
  const webUsb = React.useSyncExternalStore(subscribeNever, isWebUsbSupported, () => null);

  if (webUsb === false) {
    return (
      <button
        type="button"
        title={t('printer.unsupportedTitle')}
        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 text-xs font-semibold text-warning"
      >
        <AlertCircle className="h-3.5 w-3.5" />
        {t('printer.browserPrint')}
      </button>
    );
  }

  const handleClick = async () => {
    setBusy(true);
    try {
      await pair();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'webusb_unsupported') {
        // The browser's and the driver's own wording is logged, not shown.
        console.error('counter: printer pairing failed', err);
        await notify({
          title: t('printer.pairFailed'),
          body:
            (err as Error)?.name === 'NotFoundError'
              ? t('printer.noneSelected')
              : t('printer.pairFailedBody'),
        });
      }
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
        title={t('printer.connectedTitle', { vendor: vendor || t('printer.usbPrinter') })}
        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-3 text-xs font-semibold text-success"
      >
        <PrinterCheck className="h-3.5 w-3.5" />
        {t('printer.ready')}
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
      {busy ? t('printer.pairing') : t('printer.pair')}
    </button>
  );
}
