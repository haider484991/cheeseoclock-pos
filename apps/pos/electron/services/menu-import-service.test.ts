/**
 * Reading a menu file (menu-import-service.ts): ONE check for a file picked
 * in Menu → Import and a file from the costing PC — a byte-order mark
 * dropped, JSON, a format this till reads ("update the till" for a newer
 * one), the full schema — and the picked file is left alone by an automatic
 * import in between. EVERY MENU IS MADE UP.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MENU_FILE_VERSION, menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import { DatabaseSync } from '../db/costing-shop.fixture.js';
import { openTill } from '../db/two-tills.fixture.js';
import { madeUpMenu } from './menu-deploy-website.fixture.js';
import { menuRows } from './menu-package-till.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const svc = () => import('./menu-import-service.js');

describe('parseMenuFileText: the one check', () => {
  it('a byte-order mark (Excel / Notepad) reads the same', async () => {
    const { parseMenuFileText } = await svc();
    const text = JSON.stringify(madeUpMenu('bom'));
    expect(parseMenuFileText(`\uFEFF${text}`)).toEqual(parseMenuFileText(text));
  });

  it('not JSON: plain words', async () => {
    const { parseMenuFileText, MenuImportFileError } = await svc();
    expect(() => parseMenuFileText('{ not json')).toThrow(MenuImportFileError);
    expect(() => parseMenuFileText('{ not json')).toThrow('That file is not a menu file (it is not valid JSON).');
  });

  it('a newer format than this till reads: "update the till", before any other check', async () => {
    const { parseMenuFileText } = await svc();
    expect(() => parseMenuFileText(JSON.stringify(madeUpMenu('v4', { version: MAX_MENU_FILE_VERSION + 1, items: 'garbage' })))).toThrow(
      `This menu file is newer than this till (format ${MAX_MENU_FILE_VERSION + 1}; this till reads up to ${MAX_MENU_FILE_VERSION}). Update the till (Settings → About), then import it again.`,
    );
    // The newest it reads is fine.
    expect(parseMenuFileText(JSON.stringify(madeUpMenu('v3', { version: MAX_MENU_FILE_VERSION }))).version).toBe(MAX_MENU_FILE_VERSION);
  });

  it('MAX_MENU_FILE_VERSION is the schema’s newest version: MAX reads, MAX + 1 does not', () => {
    const base = madeUpMenu('max');
    expect(menuImportFileSchema.safeParse({ ...base, version: MAX_MENU_FILE_VERSION }).success).toBe(true);
    expect(menuImportFileSchema.safeParse({ ...base, version: MAX_MENU_FILE_VERSION + 1 }).success).toBe(false);
  });

  it('a schema problem names where it is', async () => {
    const { parseMenuFileText } = await svc();
    const bad = madeUpMenu('bad');
    (bad['items'] as Array<Record<string, unknown>>)[0]!['category'] = 'No Such Category';
    expect(() => parseMenuFileText(JSON.stringify(bad))).toThrow(/^The menu file has a problem \(at items\.0\.category\): /);
  });

  it('a choice group no one could satisfy is refused (it would make every item that asks it unsellable)', async () => {
    const { parseMenuFileText } = await svc();
    const withGroup = (g: Record<string, unknown>) => {
      const m = madeUpMenu('groups');
      const groups = m['modifierGroups'] as Array<Record<string, unknown>>;
      groups[0] = { ...groups[0]!, ...g };
      return JSON.stringify(m);
    };
    // A single choice that needs two picks.
    expect(() => parseMenuFileText(withGroup({ selectionType: 'single', minSelect: 2, maxSelect: 2, required: true }))).toThrow(
      /\(at modifierGroups\.0\.minSelect\): "Test dip" is a single choice but asks for 2 picks/,
    );
    // More picks than it has options (the made-up dip has 2).
    expect(() => parseMenuFileText(withGroup({ selectionType: 'multi', minSelect: 3, maxSelect: 3, required: true }))).toThrow(
      /"Test dip" asks for 3 picks but has only 2 options/,
    );
    // What a real file has: fine.
    expect(() => parseMenuFileText(withGroup({ selectionType: 'single', minSelect: 1, maxSelect: 1, required: true }))).not.toThrow();
    expect(() => parseMenuFileText(withGroup({ selectionType: 'multi', minSelect: 2, maxSelect: 2, required: true }))).not.toThrow();
    expect(() => parseMenuFileText(withGroup({ selectionType: 'multi', minSelect: 0, maxSelect: 1, required: false }))).not.toThrow();
  });
});

describe.skipIf(!DatabaseSync)('a picked file (Menu → Import)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-menu-file-'));
  });
  afterEach(() => {
    delete process.env['COC_MENU_IMPORT_FILE'];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pick = (name: string, text: string | Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    process.env['COC_MENU_IMPORT_FILE'] = file;
  };

  it('over 5 MB is refused as too large; the same checks as above for the rest', async () => {
    const { pickMenuImport } = await svc();
    const db = openTill('till-1');
    pick('huge.json', Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    await expect(pickMenuImport(db)).rejects.toThrow('That file is too large to be a menu file.');
    pick('v4.json', JSON.stringify(madeUpMenu('v4', { version: 4 })));
    await expect(pickMenuImport(db)).rejects.toThrow('This menu file is newer than this till (format 4; this till reads up to 3).');
    pick('bom.json', `\uFEFF${JSON.stringify(madeUpMenu('bom'))}`);
    await expect(pickMenuImport(db)).resolves.toMatchObject({ fileName: 'bom.json', summary: { newItems: 2 } });
  });

  it('an automatic import in between leaves the picked file alone: its preview still applies', async () => {
    const { pickMenuImport, applyPickedMenuImport } = await svc();
    const { applyMenuImport } = await import('../db/repositories/menu-import-repo.js');
    const db = openTill('till-1');
    const picked = madeUpMenu('picked', { items: [{ name: 'Test Picked Pizza', category: 'Test Pizzas', priceCents: 99_000 }] });
    pick('picked.json', JSON.stringify(picked));
    await pickMenuImport(db);
    // A file from the costing PC goes in meanwhile (the package path never touches the picked file).
    applyMenuImport(db, menuImportFileSchema.parse(madeUpMenu('auto')), 'auto.json', { userId: null, deviceId: 'till-1' }, {
      package: {
        id: '0b8f6c8e-8f8a-4c8a-9d2e-1c6a7d2b9e10',
        seq: 1,
        sha256: 'b'.repeat(64),
        fileName: 'auto.json',
        uploadedAt: '2026-09-29T09:00:00.000Z',
        generatedAt: '2026-09-29T08:55:00.000Z',
        automatic: true,
      },
    });
    expect(menuRows(db).items).toBe(2);
    const s = applyPickedMenuImport(db, { userId: 'u_mgr', deviceId: 'till-1' });
    expect(s.newItems).toBe(1);
    expect(menuRows(db).items).toBe(3);
  });
});
