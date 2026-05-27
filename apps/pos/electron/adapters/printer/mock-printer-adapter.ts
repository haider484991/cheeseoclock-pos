import { v7 as uuidv7 } from 'uuid';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import type {
  PrinterAdapter,
  PrintResult,
  PrinterConnectionConfig,
} from '@cheeseoclock/printer-core';
import { renderTestPage } from './test-page.js';

/**
 * No-hardware-required adapter. Writes the would-be-sent bytes to a file under
 * userData/printer-mock/<timestamp>.bin and a human-readable .txt alongside.
 * Use this when developing without a printer attached.
 */
export class MockPrinterAdapter implements PrinterAdapter {
  readonly id: string;
  readonly config: PrinterConnectionConfig;
  private connected = false;

  constructor(config: PrinterConnectionConfig) {
    this.id = uuidv7();
    this.config = config;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }

  async send(bytes: Uint8Array): Promise<PrintResult> {
    const start = Date.now();
    try {
      const dir = path.join(app.getPath('userData'), 'printer-mock');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const binPath = path.join(dir, `${stamp}.bin`);
      const txtPath = path.join(dir, `${stamp}.txt`);
      fs.writeFileSync(binPath, Buffer.from(bytes));
      fs.writeFileSync(txtPath, decodeForHuman(bytes));
      log.info('Mock printer wrote receipt', { binPath, bytes: bytes.length });
      return { ok: true, durationMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        durationMs: Date.now() - start,
        error: {
          code: 'mock_write_failed',
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        },
      };
    }
  }

  async testPrint(): Promise<PrintResult> {
    return this.send(renderTestPage(this.config.width ?? 48));
  }
}

/**
 * Strip ESC/POS control bytes for a readable .txt sibling file. This is purely
 * for debugging — the .bin alongside is the real artifact.
 */
function decodeForHuman(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0a) {
      out += '\n';
      continue;
    }
    if (b === 0x0d) continue;
    // Skip ESC/GS command sequences (2-5 bytes typically)
    if (b === 0x1b || b === 0x1d) {
      // Heuristic: skip the next 1-3 control bytes
      // ESC @ (1 arg), ESC a n (1 arg), ESC E n (1 arg), GS ! n (1 arg), GS V m (1 arg)…
      // ESC p m t1 t2 (3 args), ESC d n (1 arg)
      const next = bytes[i + 1];
      if (next === 0x70) {
        i += 4; // ESC p m t1 t2
      } else {
        i += 2; // most are 2 bytes after ESC/GS
      }
      continue;
    }
    if (b >= 0x20 && b < 0x80) out += String.fromCharCode(b);
  }
  return out;
}
