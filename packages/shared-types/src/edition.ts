/**
 * Which product a till build is. Set once, at build time (COC_EDITION →
 * electron.vite.config.ts `__EDITION__`, with the matching electron-builder
 * config); never read at run time.
 *
 *  - 'cheeseoclock' (the default: unset): Cheese O'Clock's own till exactly
 *    as released — its name, its Windows app id (the start-up entry and the
 *    notices), its data folder (%APPDATA%\@cheeseoclock\pos) and its update
 *    feed (github.com/haider484991/cheeseoclock-pos, electron-builder.yml).
 *  - 'pixelandoak': Pixel & Oak POS, the till new client shops download —
 *    its own name, app id, data folder (%APPDATA%\pixelandoak-pos) and update
 *    feed (github.com/haider484991/pixelandoak-pos,
 *    electron-builder.pixelandoak.yml). The two install side by side, and
 *    neither ever opens, starts or updates the other.
 *
 * Only names live here: what a till does is the same in both.
 */

export const EDITION_IDS = ['cheeseoclock', 'pixelandoak'] as const;
export type EditionId = (typeof EDITION_IDS)[number];

export interface Edition {
  id: EditionId;
  /** The app's name: the window title, the setup screen, Windows' notices and lists (electron-builder productName). */
  appName: string;
  /** Windows' app id (electron-builder appId): the notices, the taskbar, and the name of the start-up entry. */
  appUserModelId: string;
  /** The uninstaller the installer writes next to the exe ("Uninstall <productName>.exe"): only an installed till has one. */
  uninstallerName: string;
  /** The machine-wide folder (%ProgramData%\<this>) that keeps the licence trial's marker. */
  machineFolderName: string;
  /** The website address Settings and the restore screen show as an example. */
  exampleSiteUrl: string;
  /** The website the restore screen starts with ('' = none: the owner types the shop's own). */
  restoreSiteUrl: string;
}

export const EDITIONS: Readonly<Record<EditionId, Readonly<Edition>>> = Object.freeze({
  // Every value exactly as the till had it before there were editions.
  cheeseoclock: Object.freeze({
    id: 'cheeseoclock',
    appName: 'CheeseOclock POS',
    appUserModelId: 'pk.cheeseoclock.pos',
    uninstallerName: 'Uninstall CheeseOclock POS.exe',
    machineFolderName: 'CheeseOclock POS',
    exampleSiteUrl: 'https://www.cheeseoclock.net',
    restoreSiteUrl: 'https://www.cheeseoclock.net',
  }),
  pixelandoak: Object.freeze({
    id: 'pixelandoak',
    appName: 'Pixel & Oak POS',
    appUserModelId: 'com.pixelandoak.pos',
    uninstallerName: 'Uninstall Pixel & Oak POS.exe',
    machineFolderName: 'Pixel & Oak POS',
    exampleSiteUrl: 'https://www.yourshop.pk',
    restoreSiteUrl: '',
  }),
});

/**
 * The edition a build baked in. None (a test run, a dev tool that does not
 * bake it) is Cheese O'Clock's — what every till was before editions. The
 * build itself refuses an id it does not know (electron.vite.config.ts).
 */
export function editionOf(id: unknown): Readonly<Edition> {
  return typeof id === 'string' && (EDITION_IDS as readonly string[]).includes(id) ? EDITIONS[id as EditionId] : EDITIONS.cheeseoclock;
}
