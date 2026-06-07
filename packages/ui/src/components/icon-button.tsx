import * as React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '../lib/cn';

export interface IconButtonProps extends HTMLMotionProps<'button'> {
  variant?: 'solid' | 'ghost' | 'glass';
  size?: 'sm' | 'md' | 'lg';
  label: string;
}

const sizes = {
  sm: 'h-9 w-9',
  md: 'h-11 w-11 min-h-touch min-w-touch',
  lg: 'h-14 w-14 min-h-touch-lg min-w-touch-lg',
};

const variants = {
  solid: 'bg-primary text-primary-foreground shadow-soft hover:brightness-110',
  ghost: 'bg-transparent text-foreground hover:bg-muted',
  glass: 'glass text-foreground',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant = 'ghost', size = 'md', label, children, ...props }, ref) => (
    <motion.button
      ref={ref}
      aria-label={label}
      whileTap={{ scale: 0.92 }}
      whileHover={{ scale: 1.06 }}
      transition={{ type: 'spring', stiffness: 500, damping: 22 }}
      className={cn(
        'focus-ring inline-flex items-center justify-center rounded-full transition-colors',
        sizes[size],
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </motion.button>
  ),
);
IconButton.displayName = 'IconButton';
