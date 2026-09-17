'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IconButton, useTheme } from '@favornoms/ui';

export function ThemeToggle() {
  const t = useTranslations('common');
  const { mode, toggleMode } = useTheme();
  return (
    <IconButton label={mode === 'dark' ? t('switchToLight') : t('switchToDark')} onClick={toggleMode}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={mode}
          initial={{ rotate: -45, opacity: 0, scale: 0.6 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          exit={{ rotate: 45, opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.2 }}
        >
          {mode === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </motion.span>
      </AnimatePresence>
    </IconButton>
  );
}
