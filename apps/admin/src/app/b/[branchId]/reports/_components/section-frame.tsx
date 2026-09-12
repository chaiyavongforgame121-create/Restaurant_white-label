'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card } from '@favornoms/ui';

/**
 * A failed section must not blank the other five. Every section renders through here, so
 * one broken RPC costs the merchant that heading and nothing else — and it shows the
 * database's own words, which support can act on, instead of "try again later".
 */
export function SectionFrame({
  id,
  title,
  icon,
  caption,
  error,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  caption?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    // scroll-mt clears the toolbar pinned at the top of the reports page: without it a tab
    // click parked the section heading behind the bar and the merchant landed on a headless
    // table. The mobile figure is the tall case, where a custom range's two date fields wrap
    // the picker onto a second row.
    <section id={id} className="mt-10 scroll-mt-36 lg:scroll-mt-28">
      <header className="mb-3 flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold">{title}</h2>
          {caption ? <p className="text-xs text-muted-foreground">{caption}</p> : null}
        </div>
      </header>
      {error ? <SectionAlert title={`${title} could not be loaded`} message={error} /> : children}
    </section>
  );
}

export function SectionAlert({ title, message }: { title: string; message: string }) {
  return (
    <Card className="p-5" role="alert">
      <h3 className="flex items-center gap-2 font-display text-base font-semibold text-danger">
        <AlertTriangle className="h-4 w-4" /> {title}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Your data is safe — this is a problem reading it. Reload the page; if it keeps
        happening, send the message below to support.
      </p>
      <p className="mt-3 break-words rounded-xl bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
        {message}
      </p>
    </Card>
  );
}

/** A quiet line explaining a number that would otherwise read as a bug. */
export function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs text-muted-foreground">{children}</p>;
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-sm text-muted-foreground">{children}</p>;
}
