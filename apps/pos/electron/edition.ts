import { editionOf } from '@cheeseoclock/shared-types';

/**
 * This build's edition (shared-types edition.ts): Cheese O'Clock's till, or
 * Pixel & Oak POS for client shops. Baked in by electron.vite.config.ts
 * (`__EDITION__`, build-flags.d.ts); Cheese O'Clock's where none was baked in
 * (tests).
 */
export const EDITION = editionOf(typeof __EDITION__ === 'string' ? __EDITION__ : undefined);
