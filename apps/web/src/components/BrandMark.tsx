'use client';

import { useState } from 'react';
import { Logo } from './Logo';

/**
 * Renders the real Cheese O'Clock logo from /public/logo.png (your exact
 * artwork with the background removed by `pnpm logo:clean`). Until that file
 * exists, it falls back to the vector mark so the site never looks broken.
 */
export function BrandMark({
  stacked = false,
  dark = false,
  className = '',
}: {
  stacked?: boolean;
  dark?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/logo.png"
        alt="Cheese O'Clock"
        onError={() => setFailed(true)}
        className={`${stacked ? 'h-56 w-auto' : 'h-11 w-auto'} ${className}`}
      />
    );
  }
  return <Logo stacked={stacked} dark={dark} className={className} />;
}
