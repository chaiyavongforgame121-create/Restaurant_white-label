'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { Minus, Plus } from 'lucide-react';
import { cn } from '../lib/cn';

interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizes = {
  sm: { btn: 'h-8 w-8', text: 'w-8 text-sm' },
  md: { btn: 'h-10 w-10 min-h-touch min-w-touch', text: 'w-10 text-base' },
  lg: { btn: 'h-12 w-12 min-h-touch min-w-touch', text: 'w-12 text-lg' },
};

export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = 99,
  size = 'md',
  className,
}: QuantityStepperProps) {
  const s = sizes[size];
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full bg-primary/10 p-1 text-primary',
        className,
      )}
    >
      <motion.button
        whileTap={{ scale: 0.9 }}
        type="button"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={cn(
          'focus-ring inline-flex items-center justify-center rounded-full bg-white shadow-soft transition disabled:opacity-40',
          s.btn,
        )}
      >
        <Minus className="h-4 w-4" />
      </motion.button>
      <motion.div
        key={value}
        initial={{ scale: 1.2, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.15 }}
        className={cn('text-center font-semibold tabular-nums', s.text)}
      >
        {value}
      </motion.div>
      <motion.button
        whileTap={{ scale: 0.9 }}
        type="button"
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={cn(
          'focus-ring inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-soft transition disabled:opacity-40',
          s.btn,
        )}
      >
        <Plus className="h-4 w-4" />
      </motion.button>
    </div>
  );
}
