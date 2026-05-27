import type { HTMLAttributes } from 'react';
import { cn } from './cn.js';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Hover lift + cursor:pointer styling — use for clickable cards. */
  interactive?: boolean;
}

export function Card({ className, interactive, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        // Soft modern surface — subtle ring, low-key shadow, generous radius.
        'rounded-2xl bg-white p-5 shadow-soft ring-1 ring-stone-200/60',
        'dark:bg-stone-900 dark:ring-stone-800/80',
        interactive &&
          'cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-soft-md',
        className,
      )}
      {...rest}
    />
  );
}
