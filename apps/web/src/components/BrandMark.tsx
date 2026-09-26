'use client';

import { useState } from 'react';
import { Logo } from './Logo';

/**
 * The real Cheese O'Clock logo. The header and footer draw it 40–48px tall,
 * so they load /logo-header.webp (cropped to the artwork, ~18 KB) rather than
 * the 186 KB /logo.png, which stays for the JSON-LD logo and the web-app
 * manifest. If the image ever fails, the vector mark stands in.
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
        src={stacked ? '/logo.png' : '/logo-header.webp'}
        alt="Cheese O'Clock"
        width={stacked ? 760 : 201}
        height={stacked ? 524 : 132}
        decoding="async"
        onError={() => setFailed(true)}
        className={`${stacked ? 'h-56 w-auto' : 'h-12 w-auto'} ${className}`}
      />
    );
  }
  return <Logo stacked={stacked} dark={dark} className={className} />;
}
