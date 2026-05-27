import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  // Primary: warm amber gradient with subtle inset highlight — feels premium without being loud.
  primary: cn(
    'bg-gradient-to-b from-amber-400 to-amber-500 text-stone-900',
    'shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_1px_2px_rgba(0,0,0,0.04)]',
    'hover:from-amber-300 hover:to-amber-400 hover:shadow-lift',
    'active:from-amber-500 active:to-amber-600 active:shadow-soft-sm',
    'focus-visible:ring-amber-400',
  ),
  secondary: cn(
    'bg-white text-stone-700 ring-1 ring-stone-200',
    'hover:bg-stone-50 hover:ring-stone-300',
    'active:bg-stone-100',
    'dark:bg-stone-800 dark:text-stone-100 dark:ring-stone-700',
    'dark:hover:bg-stone-700 dark:hover:ring-stone-600',
    'focus-visible:ring-stone-400',
  ),
  ghost: cn(
    'bg-transparent text-stone-600',
    'hover:bg-stone-100 hover:text-stone-900',
    'active:bg-stone-200',
    'dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100',
    'focus-visible:ring-stone-400',
  ),
  danger: cn(
    'bg-gradient-to-b from-red-500 to-red-600 text-white',
    'shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(0,0,0,0.05)]',
    'hover:from-red-400 hover:to-red-500',
    'active:from-red-600 active:to-red-700',
    'focus-visible:ring-red-500',
  ),
  success: cn(
    'bg-gradient-to-b from-emerald-500 to-emerald-600 text-white',
    'shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(0,0,0,0.05)]',
    'hover:from-emerald-400 hover:to-emerald-500 hover:shadow-lift',
    'active:from-emerald-600 active:to-emerald-700',
    'focus-visible:ring-emerald-500',
  ),
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm rounded-lg',
  md: 'h-11 px-4 text-base rounded-xl',
  lg: 'h-14 px-6 text-lg rounded-xl',
  xl: 'h-20 px-8 text-2xl rounded-2xl',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-semibold tracking-tight transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white',
        'dark:focus-visible:ring-offset-stone-900',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0',
        'select-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
});
