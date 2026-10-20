import { editionOf } from '@cheeseoclock/shared-types';

/** Baked in by electron.vite.config.ts (COC_EDITION when the till was built); absent in tests. */
declare const __EDITION__: string | undefined;

/**
 * This build's edition (shared-types edition.ts): Cheese O'Clock's till, or
 * Pixel & Oak POS for client shops — the names the screens show. Cheese
 * O'Clock's where none was baked in (tests).
 */
export const EDITION = editionOf(typeof __EDITION__ === 'string' ? __EDITION__ : undefined);

/** The app's name on screen ("CheeseOclock POS", "Pixel & Oak POS"). */
export const APP_NAME = EDITION.appName;
