'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CloudOff, RefreshCcw, Wifi } from 'lucide-react';

export function ConnectionBanner() {
  const [online, setOnline] = React.useState(true);
  const [justReconnected, setJustReconnected] = React.useState(false);

  React.useEffect(() => {
    setOnline(navigator.onLine);
    const handleOnline = () => {
      setOnline(true);
      setJustReconnected(true);
      setTimeout(() => setJustReconnected(false), 2400);
    };
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <AnimatePresence>
      {!online && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          role="status"
          className="fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 bg-warning px-3 py-2 text-sm font-medium text-warning-foreground shadow-soft"
          style={{ color: '#1a1a1a' }}
        >
          <CloudOff className="h-4 w-4" />
          You're offline — viewing cached data
        </motion.div>
      )}
      {online && justReconnected && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          role="status"
          className="fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 bg-success px-3 py-2 text-sm font-medium text-white shadow-soft"
        >
          <Wifi className="h-4 w-4" />
          Back online <RefreshCcw className="h-3.5 w-3.5 animate-spin" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
