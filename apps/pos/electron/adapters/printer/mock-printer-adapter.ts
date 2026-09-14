import { v7 as uuidv7 } from 'uuid';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import {
  escPosToText,
  type PrinterAdapter,
  type PrintResult,
  type PrinterConnectionConfig,
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
      fs.writeFileSync(txtPath, escPosToText(bytes));
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
    return this.send(renderTestPage(this.config.width ?? 48, 'No printer (saved to file)'));
  }
}
