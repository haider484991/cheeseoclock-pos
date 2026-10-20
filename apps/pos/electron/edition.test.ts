/**
 * The two editions (shared-types edition.ts) and the installer configs that
 * go with them. Cheese O'Clock's names are pinned to exactly what its tills
 * have always had: its app id names the start-up entry and the notices, its
 * uninstaller tells an installed till apart, and a change to either would
 * reach its two tills with the next update. Pixel & Oak POS must differ from
 * it in every name that could make the two installs meet on one PC — the app
 * id, the start-up entry, the data folder, the update feed — and its config
 * must say the same names as the code.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDITIONS, EDITION_IDS, editionOf } from '@cheeseoclock/shared-types';
import { EDITION } from './edition.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(join(APP, file), 'utf8');
/** A top-level `key: value` of an electron-builder YAML file (the files keep these on one line). */
const top = (yaml: string, key: string) => yaml.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))?.[1] ?? null;
/** A `  key: value` line inside the `section:` block. */
const inside = (yaml: string, section: string, key: string) => {
  const block = yaml.split(/\r?\n(?=\S)/).find((b) => b.startsWith(`${section}:`)) ?? '';
  return block.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, 'm'))?.[1] ?? null;
};

describe('editions', () => {
  it('Cheese O’Clock’s names are exactly its tills’ own, and are what a build without an edition gets', () => {
    expect(EDITIONS.cheeseoclock).toEqual({
      id: 'cheeseoclock',
      appName: 'CheeseOclock POS',
      appUserModelId: 'pk.cheeseoclock.pos',
      uninstallerName: 'Uninstall CheeseOclock POS.exe',
      machineFolderName: 'CheeseOclock POS',
      exampleSiteUrl: 'https://www.cheeseoclock.net',
      restoreSiteUrl: 'https://www.cheeseoclock.net',
    });
    expect(editionOf(undefined)).toBe(EDITIONS.cheeseoclock);
    expect(editionOf('not-an-edition')).toBe(EDITIONS.cheeseoclock);
    expect(editionOf('pixelandoak')).toBe(EDITIONS.pixelandoak);
    // Tests bake in no edition: Cheese O'Clock's.
    expect(EDITION).toBe(EDITIONS.cheeseoclock);
  });

  it('Pixel & Oak POS shares no name that could make the two installs meet', () => {
    const [co, po] = [EDITIONS.cheeseoclock, EDITIONS.pixelandoak];
    expect(EDITION_IDS).toEqual(['cheeseoclock', 'pixelandoak']);
    for (const k of ['appName', 'appUserModelId', 'uninstallerName', 'machineFolderName', 'exampleSiteUrl'] as const) {
      expect(po[k], k).not.toBe(co[k]);
    }
    expect(JSON.stringify(po).toLowerCase()).not.toContain('cheese');
    // The restore screen starts empty: a client types their own website.
    expect(po.restoreSiteUrl).toBe('');
  });

  it('each installer config names its edition’s app id, name and uninstaller, and its own update feed', () => {
    const co = read('electron-builder.yml');
    const po = read('electron-builder.pixelandoak.yml');
    for (const [yaml, e] of [
      [co, EDITIONS.cheeseoclock],
      [po, EDITIONS.pixelandoak],
    ] as const) {
      expect(top(yaml, 'appId')).toBe(e.appUserModelId);
      expect(top(yaml, 'productName')).toBe(e.appName);
      // NSIS writes `Uninstall ${productName}.exe` next to the exe: the till looks for exactly that.
      expect(e.uninstallerName).toBe(`Uninstall ${top(yaml, 'productName')}.exe`);
      expect(inside(yaml, 'nsis', 'shortcutName')).toBe(e.appName);
      expect(inside(yaml, 'nsis', 'uninstallDisplayName')).toBe(e.appName);
    }
    expect(inside(co, 'publish', 'repo')).toBe('cheeseoclock-pos');
    expect(inside(po, 'publish', 'repo')).toBe('pixelandoak-pos');
    expect(inside(po, 'publish', 'owner')).toBe('haider484991');
    // Its own data folder (%APPDATA%\pixelandoak-pos) and updater cache, not Cheese O'Clock's @cheeseoclock\pos.
    expect(inside(po, 'extraMetadata', 'name')).toBe('pixelandoak-pos');
    expect(top(po, 'extends')).toBe('./electron-builder.yml');
  });

  it('the build knows the same editions and names (electron.vite.config.ts cannot import them)', () => {
    const block = read('electron.vite.config.ts').match(/const EDITION_APP_NAMES[^{]*\{([^}]*)\}/)?.[1] ?? '';
    const names = Object.fromEntries([...block.matchAll(/^\s*(\w+): '([^']+)',?\s*$/gm)].map((m) => [m[1], m[2]]));
    expect(names).toEqual(Object.fromEntries(EDITION_IDS.map((id) => [id, EDITIONS[id].appName])));
  });

  it('each uninstaller takes away its own start-up entry, and only its own', () => {
    const coScript = read(inside(read('electron-builder.yml'), 'nsis', 'include')!);
    const poScript = read(inside(read('electron-builder.pixelandoak.yml'), 'nsis', 'include')!);
    const entries = (script: string) => [...script.matchAll(/DeleteRegValue HKCU "[^"]+" "([^"]+)"/g)].map((m) => m[1]);
    expect(entries(coScript)).toEqual(['pk.cheeseoclock.pos', 'pk.cheeseoclock.pos']);
    expect(entries(poScript)).toEqual(['com.pixelandoak.pos', 'com.pixelandoak.pos']);
  });
});
