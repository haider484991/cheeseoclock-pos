/**
 * The main-process wiring that decides whether the shop logo goes on paper,
 * run against a real database built from every migration:
 *  - a print policy saved before the logo setting existed reads as logo ON;
 *  - a receipt prints the stored picture only for the logo that is set now,
 *    and only while "Logo on receipts" is on;
 *  - a test print through the real spooler and the no-printer (file) adapter
 *    marks the logo as checked on that printer, which is what the Printers
 *    tab reads back — and a new logo or another printer undoes it.
 *
 * better-sqlite3 here is built for Electron's ABI and will not open under
 * plain node, so this uses node's own `node:sqlite` (Node 22.5+) behind a
 * small better-sqlite3-shaped shim, and skips itself where it is missing.
 * Every logo and picture below is made up.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGO_RASTER_ALGO, logoFingerprint, logoMarker } from '@cheeseoclock/printer-core';
import type { ReceiptLogoRasterJson, ReceiptLogoRasterSet } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';

// Builds a real database from every migration and loads the repositories on
// first use: seconds on a slow CI runner, well past the 5 s default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// The no-printer adapter writes its .bin/.txt copies under userData/printer-mock.
const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => state.userData },
}));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
type RawDbCtor = new (path: string) => RawDb;

// require, not import: Vite's resolver does not know `node:sqlite` is built in.
let DatabaseSync: RawDbCtor | null = null;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: RawDbCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/** A fresh database with every migration, behind better-sqlite3's `transaction()` shape. */
function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth -= 1;
          if (depth === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
  } as unknown as AppDatabase;
}

const LOGO = 'data:image/png;base64,bWFkZS11cC1sb2dv'; // made up
const NEW_LOGO = 'data:image/png;base64,YW5vdGhlci1tYWRlLXVwLWxvZ28='; // made up

/** A picture of `width`×`height` dots: two dots in every eight (usable, not a block). */
function pic(paperWidth: 32 | 48, width: number, height: number): ReceiptLogoRasterJson {
  const data = Buffer.from(new Uint8Array((width / 8) * height).fill(0x81)).toString('base64');
  return { paperWidth, width, height, data };
}

/** What the screen saves for `logoUrl`: one picture per paper width. */
const pictureSetFor = (logoUrl: string): ReceiptLogoRasterSet => ({
  source: logoFingerprint(logoUrl),
  algo: LOGO_RASTER_ALGO,
  rasters: [pic(32, 120, 60), pic(48, 160, 80)],
});

const cfg = () => import('./printer-config.js');

let db: AppDatabase;
beforeEach(() => {
  if (DatabaseSync) db = openMigrated();
});

describe.skipIf(!DatabaseSync)('print policy', () => {
  it('a policy saved before "Logo on receipts" existed reads as logo on, the rest kept', async () => {
    const { getPrintPolicy, PRINT_POLICY_KEY } = await cfg();
    const { setSetting } = await import('../db/repositories/settings-repo.js');
    // Exactly what v0.7.4 stored: three rules, no logo field.
    setSetting(db, PRINT_POLICY_KEY, { kitchenTicket: false, deliveryBillOnDispatch: true, shopCopy: 'never' });
    expect(getPrintPolicy(db)).toEqual({
      kitchenTicket: false,
      deliveryBillOnDispatch: true,
      shopCopy: 'never',
      logoOnReceipt: true,
    });
  });

  it('no saved policy at all: logo on', async () => {
    const { getPrintPolicy } = await cfg();
    expect(getPrintPolicy(db).logoOnReceipt).toBe(true);
  });

  it('turned off, it stays off', async () => {
    const { getPrintPolicy, setPrintPolicy } = await cfg();
    setPrintPolicy(db, { ...getPrintPolicy(db), logoOnReceipt: false });
    expect(getPrintPolicy(db).logoOnReceipt).toBe(false);
  });
});

describe.skipIf(!DatabaseSync)('the logo a customer receipt prints', () => {
  it('prints the stored picture for the logo that is set now, on either paper', async () => {
    const { getReceiptBranding, getReceiptLogo, receiptLogoToPrint, setReceiptBranding, setReceiptLogoRaster } =
      await cfg();
    setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: LOGO });
    setReceiptLogoRaster(db, pictureSetFor(LOGO));
    const branding = getReceiptBranding(db);
    expect(getReceiptLogo(db, 48, branding)).toMatchObject({ state: 'ready', enabled: true });
    expect(receiptLogoToPrint(db, 48, branding)).toMatchObject({ width: 160, height: 80 });
    expect(receiptLogoToPrint(db, 32, branding)).toMatchObject({ width: 120, height: 60 });
  });

  it('prints nothing while "Logo on receipts" is off, though the picture is ready', async () => {
    const m = await cfg();
    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: LOGO });
    m.setReceiptLogoRaster(db, pictureSetFor(LOGO));
    m.setPrintPolicy(db, { ...m.getPrintPolicy(db), logoOnReceipt: false });
    const branding = m.getReceiptBranding(db);
    expect(m.getReceiptLogo(db, 48, branding)).toMatchObject({ state: 'ready', enabled: false });
    expect(m.receiptLogoToPrint(db, 48, branding)).toBeNull();
    // Back on: it prints again.
    m.setPrintPolicy(db, { ...m.getPrintPolicy(db), logoOnReceipt: true });
    expect(m.receiptLogoToPrint(db, 48, branding)).not.toBeNull();
  });

  it('prints nothing once the logo changes, until the new picture is saved', async () => {
    const m = await cfg();
    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: LOGO });
    m.setReceiptLogoRaster(db, pictureSetFor(LOGO));
    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: NEW_LOGO });
    const branding = m.getReceiptBranding(db);
    expect(m.getReceiptLogo(db, 48, branding).state).toBe('not_ready');
    expect(m.receiptLogoToPrint(db, 48, branding)).toBeNull();
    m.setReceiptLogoRaster(db, pictureSetFor(NEW_LOGO));
    expect(m.receiptLogoToPrint(db, 48, branding)).not.toBeNull();
  });

  it('prints nothing without a logo, or with a damaged picture', async () => {
    const m = await cfg();
    const { setSetting } = await import('../db/repositories/settings-repo.js');
    const { LOGO_RASTER_KEY } = await import('./receipt-logo.js');
    m.setReceiptLogoRaster(db, pictureSetFor(LOGO));
    expect(m.getReceiptLogo(db, 48).state).toBe('none');
    expect(m.receiptLogoToPrint(db, 48, m.getReceiptBranding(db))).toBeNull();

    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: LOGO });
    setSetting(db, LOGO_RASTER_KEY, { ...pictureSetFor(LOGO), rasters: [{ ...pic(48, 160, 80), data: 'AAAA' }] });
    expect(m.getReceiptLogo(db, 48).state).toBe('not_ready');
    expect(m.receiptLogoToPrint(db, 48, m.getReceiptBranding(db))).toBeNull();
  });
});

describe.skipIf(!DatabaseSync)('the logo test print', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A test print on the receipt printer, through the real spooler and the no-printer adapter. */
  async function testPrint(): Promise<string> {
    state.userData = mkdtempSync(join(tmpdir(), 'coc-logo-test-'));
    dirs.push(state.userData);
    const { printSpooler } = await import('./print-spooler.js');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // no background ticks
    try {
      printSpooler.init(db);
      printSpooler.resetAdapter();
      const result = await printSpooler.testPrintNow('receipt');
      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const dir = join(state.userData, 'printer-mock');
    const txt = readdirSync(dir).filter((f) => f.endsWith('.txt'));
    expect(txt).toHaveLength(1);
    return readFileSync(join(dir, txt[0]!), 'utf8');
  }

  /** What the Printers tab reads back (printer:getConfig). */
  async function checkedNow(): Promise<boolean> {
    const m = await cfg();
    return m.getReceiptLogoStatus(db, m.getReceiptPrinterConfig(db) ?? m.DEFAULT_RECEIPT_CONFIG).checked;
  }

  it('prints the logo and marks it checked on the default (no printer) setup', async () => {
    const m = await cfg();
    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: LOGO });
    m.setReceiptLogoRaster(db, pictureSetFor(LOGO));
    expect(await checkedNow()).toBe(false);
    const page = await testPrint();
    // Sent across the full 80 mm width, so the logo is centred on any printer.
    expect(page).toContain(logoMarker(576, 80));
    expect(page).toMatch(/Logo\s+should be above/);
    expect(await checkedNow()).toBe(true);
  });

  it('does the same for a saved 58 mm printer, and prints the logo even with it off for receipts', async () => {
    const m = await cfg();
    m.setReceiptPrinterConfig(db, { transport: 'network', network: { host: 'mock', port: 9100 }, width: 32 });
    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: LOGO });
    m.setReceiptLogoRaster(db, pictureSetFor(LOGO));
    m.setPrintPolicy(db, { ...m.getPrintPolicy(db), logoOnReceipt: false });
    const page = await testPrint();
    expect(page).toContain(logoMarker(384, 60));
    expect(page).toMatch(/Logo on receipts\s+off/);
    expect(await checkedNow()).toBe(true);
  });

  it('marks nothing checked when there is no logo to print', async () => {
    const page = await testPrint();
    expect(page).not.toContain('[logo');
    expect(await checkedNow()).toBe(false);
  });

  it('a new logo, or another printer, needs a new test print', async () => {
    const m = await cfg();
    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: LOGO });
    m.markReceiptLogoChecked(db, LOGO, m.DEFAULT_RECEIPT_CONFIG);
    expect(await checkedNow()).toBe(true);

    m.setReceiptPrinterConfig(db, { transport: 'network', network: { host: '192.0.2.10', port: 9100 }, width: 48 });
    expect(await checkedNow()).toBe(false);
    m.setReceiptPrinterConfig(db, m.DEFAULT_RECEIPT_CONFIG);
    expect(await checkedNow()).toBe(true);

    m.setReceiptBranding(db, { storeName: 'Test Shop', logoUrl: NEW_LOGO });
    expect(await checkedNow()).toBe(false);
  });
});
