'use client';

// The landing page of every emailed auth link. It spends nothing on load: the link is verified
// only when Continue is pressed (a plain form POST to /auth/confirm/verify), so a mail scanner
// or a link preview that opens the page first leaves the link usable, and the token_hash is
// verified on the server, so the email can be opened on any device. See ../../_lib/email-link.ts.
//
// The query is read from window.location rather than from searchParams on purpose: the redirect
// pasted at the end of it may carry characters a parsed query would split.

import * as React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { MailCheck, ShieldAlert } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { destinationFor, readEmailLink, type EmailLinkType } from '../../_lib/email-link';

interface Ready {
  tokenHash: string;
  type: EmailLinkType;
  next: string;
}

export function ConfirmLinkView() {
  const t = useTranslations('auth');
  const [link, setLink] = React.useState<Ready | 'invalid' | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    const { tokenHash, type, redirectTo } = readEmailLink(window.location.search);
    if (!tokenHash || !type) {
      setLink('invalid');
      return;
    }
    setLink({ tokenHash, type, next: destinationFor(redirectTo, type, window.location.origin) });
  }, []);

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4 py-10">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <MailCheck className="h-8 w-8" />
        </div>

        {link === 'invalid' ? (
          <Card className="mt-6 p-5 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-lg font-semibold">{t('confirmLink.invalidTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('confirmLink.invalidBody')}</p>
            <Link href="/login">
              <Button variant="gradient" size="lg" className="mt-5" fullWidth>
                {t('confirmLink.toLogin')}
              </Button>
            </Link>
          </Card>
        ) : (
          <>
            <h1 className="mt-5 text-center font-display text-3xl font-bold">
              {link ? t(`confirmLink.titles.${link.type}`) : t('confirmLink.working')}
            </h1>
            <p className="mt-1 text-center text-sm text-muted-foreground">{t('confirmLink.body')}</p>
            <Card className="mt-6 p-5">
              <form method="post" action="/auth/confirm/verify" onSubmit={() => setSubmitting(true)}>
                <input type="hidden" name="token_hash" value={link?.tokenHash ?? ''} />
                <input type="hidden" name="type" value={link?.type ?? ''} />
                <input type="hidden" name="next" value={link?.next ?? ''} />
                <Button
                  type="submit"
                  variant="gradient"
                  size="xl"
                  fullWidth
                  disabled={!link}
                  loading={submitting}
                >
                  {t('confirmLink.button')}
                </Button>
              </form>
            </Card>
          </>
        )}
      </motion.div>
    </div>
  );
}
