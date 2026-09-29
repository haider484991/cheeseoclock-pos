import fs from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import { MAX_MENU_FILE_VERSION, menuImportFileSchema, type MenuImportFile } from '@cheeseoclock/shared-schemas';
import type { MenuImportPreview, MenuImportSummary } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import type { Actor } from '../db/repositories/base.js';
import { applyMenuImport, planMenuImportFromDb, refuseFreshStartWhileBusy } from '../db/repositories/menu-import-repo.js';
import { createBackup } from './backup-service.js';

/** Largest menu file accepted — a full menu with recipes is well under 1 MB. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The file the manager picked and previewed. Apply only ever writes this —
 * the renderer never hands the main process a path or file contents.
 */
let picked: { fileName: string; file: MenuImportFile } | null = null;

export class MenuImportFileError extends Error {}

/** What a till says about a file written in a newer format than it reads ("update the till"). */
export function menuFileTooNewMessage(version: number): string {
  return `This menu file is newer than this till (format ${version}; this till reads up to ${MAX_MENU_FILE_VERSION}). Update the till (Settings → About), then import it again.`;
}

/**
 * A menu file's text, checked: the byte-order mark Excel / Notepad may add
 * dropped, JSON, a format this till reads (a newer one says "update the
 * till"), then the file's full schema. The ONE check for a picked file and
 * for a file from the costing PC (services/menu-package-service.ts).
 */
export function parseMenuFileText(text: string): MenuImportFile {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new MenuImportFileError('That file is not a menu file (it is not valid JSON).');
  }
  const version = typeof json === 'object' && json !== null ? (json as { version?: unknown }).version : undefined;
  if (typeof version === 'number' && Number.isInteger(version) && version > MAX_MENU_FILE_VERSION) {
    throw new MenuImportFileError(menuFileTooNewMessage(version));
  }
  const parsed = menuImportFileSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` (at ${first.path.join('.')})` : '';
    throw new MenuImportFileError(`The menu file has a problem${where}: ${first?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

function readMenuFile(filePath: string): MenuImportFile {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BYTES) throw new MenuImportFileError('That file is too large to be a menu file.');
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new MenuImportFileError('That file could not be read.');
  }
  return parseMenuFileText(text);
}

/**
 * Ask for a menu file and return what importing it would change, or null when
 * the dialog is cancelled. Dev runs can set COC_MENU_IMPORT_FILE to skip the
 * dialog (scripted tests); packaged builds always ask.
 */
export async function pickMenuImport(db: AppDatabase): Promise<MenuImportPreview | null> {
  let filePath = !app.isPackaged ? process.env.COC_MENU_IMPORT_FILE : undefined;
  if (!filePath) {
    const result = await dialog.showOpenDialog({
      title: 'Choose a menu file',
      properties: ['openFile'],
      filters: [{ name: 'Menu file', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    filePath = result.filePaths[0];
  }
  const file = readMenuFile(filePath);
  const fileName = path.basename(filePath);
  picked = { fileName, file };
  return { fileName, ...planMenuImportFromDb(db, file).preview };
}

/** Re-plan the picked file — as an update, or as a fresh start. */
export function previewPickedMenuImport(db: AppDatabase, fresh: boolean): MenuImportPreview {
  if (!picked) throw new MenuImportFileError('Choose a menu file first.');
  return { fileName: picked.fileName, ...planMenuImportFromDb(db, picked.file, { fresh }).preview };
}

/**
 * fresh: the whole current menu is removed before the file is loaded. A local
 * backup (Settings → Backups) is taken first, so the old menu can be restored.
 */
export function applyPickedMenuImport(db: AppDatabase, actor: Actor, opts: { fresh?: boolean } = {}): MenuImportSummary {
  if (!picked) throw new MenuImportFileError('Choose a menu file first.');
  const { file, fileName } = picked;
  if (opts.fresh) {
    refuseFreshStartWhileBusy(db);
    createBackup({ kind: 'manual' });
  }
  const summary = applyMenuImport(db, file, fileName, actor, { fresh: opts.fresh });
  picked = null;
  return summary;
}
