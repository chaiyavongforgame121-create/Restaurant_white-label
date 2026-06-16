'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, FileSearch, X } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';

interface Doc {
  key: string;
  label: string;
  url: string | null;
}

const DOC_TYPES = [
  { key: 'license', label: 'Driver license' },
  { key: 'vehicle_reg', label: 'Vehicle reg.' },
  { key: 'selfie', label: 'Selfie with license' },
] as const;

export function KycReviewButton({
  driverId,
  currentStatus,
}: {
  driverId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [docs, setDocs] = React.useState<Doc[]>([]);
  const [busy, setBusy] = React.useState(false);

  const openDialog = async () => {
    setOpen(true);
    const supabase = getBrowserClient();
    const { data } = await supabase.storage.from('driver-kyc').list(driverId, { limit: 50 });
    const next: Doc[] = await Promise.all(
      DOC_TYPES.map(async (doc) => {
        const match = data?.find((f) => f.name.startsWith(`${doc.key}.`));
        if (!match) return { key: doc.key, label: doc.label, url: null };
        const { data: signed } = await supabase.storage
          .from('driver-kyc')
          .createSignedUrl(`${driverId}/${match.name}`, 60 * 10);
        return { key: doc.key, label: doc.label, url: signed?.signedUrl ?? null };
      }),
    );
    setDocs(next);
  };

  const setStatus = async (status: 'verified' | 'rejected') => {
    setBusy(true);
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('set_driver_kyc_status', {
      p_driver_id: driverId,
      p_status: status,
    });
    setBusy(false);
    if (error) {
      alert(error.message);
      return;
    }
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <Button size="sm" variant="ghost" leftIcon={<FileSearch className="h-4 w-4" />} onClick={openDialog}>
        Review KYC
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[120] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 10, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-5 shadow-2xl"
            >
              <header className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="font-display text-xl font-bold">KYC review</h2>
                  <p className="text-xs text-muted-foreground">Current status: {currentStatus}</p>
                </div>
                <button onClick={() => setOpen(false)} className="focus-ring rounded-full p-1.5 hover:bg-muted">
                  <X className="h-5 w-5" />
                </button>
              </header>

              <ul className="space-y-3">
                {docs.map((d) => (
                  <li key={d.key}>
                    <Card className="overflow-hidden p-0">
                      <header className="flex items-center justify-between bg-muted/40 px-4 py-2">
                        <p className="font-semibold">{d.label}</p>
                        {d.url ? (
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold text-primary"
                          >
                            Open full size
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not uploaded</span>
                        )}
                      </header>
                      {d.url ? (
                        d.url.endsWith('.pdf') ? (
                          <iframe src={d.url} className="h-64 w-full bg-muted" title={d.label} />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={d.url} alt={d.label} className="max-h-72 w-full object-contain bg-muted" />
                        )
                      ) : (
                        <div className="grid h-32 place-items-center text-sm text-muted-foreground">
                          Awaiting upload
                        </div>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>

              <footer className="mt-5 flex gap-2">
                <Button
                  variant="outline"
                  leftIcon={<X className="h-4 w-4" />}
                  onClick={() => setStatus('rejected')}
                  loading={busy}
                  fullWidth
                >
                  Reject
                </Button>
                <Button
                  variant="gradient"
                  leftIcon={<Check className="h-4 w-4" />}
                  onClick={() => setStatus('verified')}
                  loading={busy}
                  fullWidth
                >
                  Verify
                </Button>
              </footer>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
