'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '../lib/cn';

const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-2 select-none',
    'font-medium tracking-tight whitespace-nowrap',
    'transition-[transform,box-shadow,background-color,color] duration-200',
    'focus-ring active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    'rounded-[var(--radius)] overflow-hidden',
  ].join(' '),
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-warm hover:shadow-glow hover:brightness-110',
        gradient:
          'bg-gradient-warm bg-[length:200%_200%] animate-gradient text-white shadow-warm hover:shadow-glow',
        secondary:
          'bg-secondary text-secondary-foreground hover:brightness-110 shadow-soft',
        outline:
          'border-2 border-primary/30 bg-transparent text-primary hover:bg-primary/10 hover:border-primary',
        ghost:
          'bg-transparent text-foreground hover:bg-muted',
        soft:
          'bg-primary/10 text-primary hover:bg-primary/15',
        danger:
          'bg-danger text-white hover:brightness-110 shadow-soft',
        glass:
          'glass text-foreground hover:bg-white/80',
      },
      size: {
        sm: 'h-9 px-3.5 text-sm',
        md: 'h-11 px-5 text-base min-h-touch',
        lg: 'h-12 px-6 text-base min-h-touch',
        xl: 'h-14 px-7 text-lg min-h-touch-lg',
        icon: 'h-11 w-11 min-h-touch min-w-touch',
        'icon-sm': 'h-9 w-9',
        'icon-lg': 'h-14 w-14 min-h-touch-lg min-w-touch-lg',
      },
      fullWidth: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

type MotionButtonProps = HTMLMotionProps<'button'>;

export interface ButtonProps
  extends Omit<MotionButtonProps, 'size'>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, fullWidth, loading, leftIcon, rightIcon, children, disabled, ...props },
    ref,
  ) => {
    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: 0.97 }}
        whileHover={{ y: -1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 22 }}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
        ) : (
          leftIcon
        )}
        {children as React.ReactNode}
        {!loading && rightIcon}
      </motion.button>
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
