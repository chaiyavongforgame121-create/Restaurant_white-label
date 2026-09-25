'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { Check, ChevronRight, Copy, QrCode, Share2 } from 'lucide-react';
import { Button, Sheet, copyText } from '@favornoms/ui';

/**
 * "Share FavorGO": a code another rider scans off this phone to get the app.
 *
 * Riders recruit riders — the one standing next to you at the pickup counter is the likeliest
 * next sign-up — and until now the only way to pass the app on was to spell out a
 * vercel.app address. The code is drawn on the phone (qrcode.react, no network), so it still
 * works in the dead-signal car park where that conversation usually happens.
 *
 * It points at this app's own origin, the same root the back office's code uses: the root
 * sends a signed-in rider to their home screen and a new one on to sign-up, so neither app
 * needs to know the other's screens.
 */
export function ShareAppRow() {
  const t = useTranslations('profile.share');
  const [open, setOpen] = React.useState(false);
  // Only known in the browser, and only needed once the sheet opens.
  const [url, setUrl] = React.useState<string | null>(null);
  const [canShare, setCanShare] = React.useState(false);
  const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    setUrl(window.location.origin);
    // Read after mount so the button never appears where it would do nothing.
    setCanShare(typeof navigator.share === 'function');
    return () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    };
  }, []);

  const copyLink = async () => {
    if (!url) return;
    const next = (await copyText(url)) ? 'copied' : 'failed';
    setCopy(next);
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopy('idle'), next === 'copied' ? 1500 : 4000);
  };

  const share = async () => {
    if (!url) return;
    try {
      await navigator.share({ title: 'FavorGO', text: t('shareText'), url });
    } catch {
      /* closing the share sheet rejects with AbortError; nothing to report */
    }
  };

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-soft"
      >
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <QrCode className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('rowTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('rowSubtitle')}</p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={t('sheetTitle')} ariaLabel={t('sheetTitle')}>
        {url && (
          <div className="flex flex-col items-center gap-4 pb-2 text-center">
            <p className="text-sm text-muted-foreground">{t('intro')}</p>
            {/* White behind the code in both themes: a dark quiet zone is what phone cameras
                reliably fail to read, and this one is scanned off a screen. */}
            <div className="rounded-2xl bg-white p-4 shadow-soft">
              <QRCodeSVG
                value={url}
                size={220}
                level="M"
                marginSize={2}
                role="img"
                aria-label={t('qrLabel')}
              />
            </div>
            <p className="w-full break-all rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
              {url}
            </p>
            {/* Stacked, not side by side: the shared Button never wraps its label, and
                "Sao chép liên kết" beside "Chia sẻ" does not fit half a phone's width. */}
            <div className="grid w-full gap-2">
              {canShare && (
                <Button
                  variant="gradient"
                  fullWidth
                  leftIcon={<Share2 className="h-4 w-4" />}
                  onClick={share}
                >
                  {t('shareLink')}
                </Button>
              )}
              <Button
                variant="outline"
                fullWidth
                leftIcon={copy === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                onClick={copyLink}
              >
                {copy === 'copied' ? t('copied') : t('copyLink')}
              </Button>
            </div>
            <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
              {copy === 'failed' ? t('copyFailed') : null}
            </p>
          </div>
        )}
      </Sheet>
    </li>
  );
}
