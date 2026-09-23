import fs from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import { menuImportFileSchema, type MenuImportFile } from '@cheeseoclock/shared-schemas';
import type { MenuImportPreview, MenuImportSummary } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import type { Actor } from '../db/repositories/base.js';
import { applyMenuImport, planMenuImportFromDb } from '../db/repositories/menu-import-repo.js';

/** Largest menu file accepted — a full menu with recipes is well under 1 MB. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The file the manager picked and previewed. Apply only ever writes this —
 * the renderer never hands the main process a path or file contents.
 */
let picked: { fileName: string; file: MenuImportFile } | null = null;

export class MenuImportFileError extends Error {}

function readMenuFile(filePath: string): MenuImportFile {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BYTES) throw new MenuImportFileError('That file is too large to be a menu file.');
  let json: unknown;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    // Excel / Notepad may prefix a byte-order mark.
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new MenuImportFileError('That file is not a menu file (it is not valid JSON).');
  }
  const parsed = menuImportFileSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` (at ${first.path.join('.')})` : '';
    throw new MenuImportFileError(`The menu file has a problem${where}: ${first?.message ?? 'invalid'}`);
  }
  return parsed.data;
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

export function applyPickedMenuImport(db: AppDatabase, actor: Actor): MenuImportSummary {
  if (!picked) throw new MenuImportFileError('Choose a menu file first.');
  const { file, fileName } = picked;
  const summary = applyMenuImport(db, file, fileName, actor);
  picked = null;
  return summary;
}
