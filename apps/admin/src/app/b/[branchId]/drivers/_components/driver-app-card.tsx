'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Download, ExternalLink } from 'lucide-react';
import { Button, Card, RiderIcon, buttonVariants, copyText } from '@favornoms/ui';

/** Print resolution for the downloaded PNG — the same size the branch menu code uses. */
const PNG_SIZE = 1024;

const STEPS = ['scan', 'open', 'install'] as const;

interface Props {
  /** The rider app's address, already validated on the server (driverAppUrl). */
  url: string;
  /**
   * `team` — the Drivers page: a card a manager shows or prints for riders, with a PNG to
   * download. `self` — the back office's no-access page, where the person reading it IS the
   * rider: no download, a way to open the app directly, and no card of its own because it
   * sits inside that page's card.
   */
  audience: 'team' | 'self';
  /** Named in the team copy so the manager can tell riders which branch to pick. */
  branchName?: string;
}

/**
 * "Get the FavorGO app": the rider app's QR code, its address, and how to install it.
 *
 * Riders used to learn the app's address by word of mouth — nothing in the back office
 * named it, so a manager recruiting riders had no link to hand over.
 */
export function DriverAppCard({ url, audience, branchName }: Props) {
  const t = useTranslations('drivers.appCard');
  const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const resetTimer = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copyLink = async () => {
    // A refused copy says so rather than flashing nothing: the address is printed right
    // above the button, to copy by hand.
    const next = (await copyText(url)) ? 'copied' : 'failed';
    setCopy(next);
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopy('idle'), next === 'copied' ? 1500 : 4000);
  };

  // The same download branch-qr.tsx does: the visible code is an SVG, so the PNG comes
  // from an off-screen canvas painted at print size, not a blow-up of the 148px one on screen.
  const downloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'favorgo-qr.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const team = audience === 'team';
  const named = branchName?.trim();

  const body = (
    <div
      className={
        team ? 'flex flex-col gap-5 sm:flex-row sm:items-start' : 'flex flex-col items-center gap-4'
      }
    >
      {/* White behind the code in both themes: a dark quiet zone is the one thing phone
          cameras reliably fail to read. */}
      <div
        className={`shrink-0 self-center rounded-2xl bg-white p-3 shadow-soft ${team ? 'sm:self-start' : ''}`}
      >
        <QRCodeSVG
          value={url}
          size={team ? 148 : 176}
          level="M"
          marginSize={2}
          role="img"
          aria-label={t('qrLabel')}
        />
      </div>

      <div className={team ? 'min-w-0 flex-1' : 'w-full text-left'}>
        {team && (
          <>
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <RiderIcon className="h-5 w-5 text-primary" aria-hidden />
              {t('title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {named ? t('teamIntro', { branch: named }) : t('teamIntroNoBranch')}
            </p>
          </>
        )}
        {!team && <p className="text-center text-sm text-muted-foreground">{t('selfIntro')}</p>}

        <ol className="mt-3 space-y-1.5 text-sm">
          {STEPS.map((step, i) => (
            <li key={step} className="flex gap-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {i + 1}
              </span>
              <span>{t(`steps.${step}`)}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">{t('inAppHint')}</p>

        <p className="mt-3 break-all rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
          {url}
        </p>

        {/* Buttons never wrap their label (the shared Button is nowrap + overflow-hidden), so
            they sit side by side only while they fit and drop to their own line otherwise —
            "Descargar QR (PNG)" beside "Copiar enlace" does not fit a half-width column. */}
        {team ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              leftIcon={copy === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              onClick={copyLink}
            >
              {copy === 'copied' ? t('copied') : t('copyLink')}
            </Button>
            <Button variant="outline" leftIcon={<Download className="h-4 w-4" />} onClick={downloadPng}>
              {t('downloadPng')}
            </Button>
          </div>
        ) : (
          <div className="mt-3 grid gap-2">
            {/* A rider who signed in here from their phone needs no camera at all. The button
                styling sits on the anchor itself: a <button> inside an <a> is invalid markup. */}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'gradient', fullWidth: true })}
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              {t('open')}
            </a>
            <Button
              variant="outline"
              fullWidth
              leftIcon={copy === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              onClick={copyLink}
            >
              {copy === 'copied' ? t('copied') : t('copyLink')}
            </Button>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {copy === 'failed' ? t('copyFailed') : team ? t('pngHint', { size: PNG_SIZE }) : null}
        </p>
      </div>

      {team && (
        <QRCodeCanvas
          ref={canvasRef}
          value={url}
          size={PNG_SIZE}
          level="M"
          marginSize={2}
          className="hidden"
          aria-hidden
        />
      )}
    </div>
  );

  return team ? (
    <Card className="p-5">{body}</Card>
  ) : (
    <div className="mt-6 border-t border-border/60 pt-6">{body}</div>
  );
}
