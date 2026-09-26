import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type {
  PrinterAdapter,
  PrintResult,
  PrinterConnectionConfig,
  SendOptions,
  TestPageOptions,
} from '@cheeseoclock/printer-core';
import { renderTestPage } from './test-page.js';
import { RawPrintError, RawPrintWorker } from './windows-raw-print-worker.js';

/**
 * USB printer adapter — Windows only for now.
 *
 * We don't talk USB ourselves. Windows already does, the moment the printer's
 * driver is installed and it shows up under Settings → Printers & scanners.
 * We hand that queue our ESC/POS bytes as a RAW job (see
 * windows-raw-print-worker.ts), which the driver passes through untouched:
 * cut, drawer kick and QR all work exactly as over the network.
 *
 * Same contract as the other adapters: print failure never blocks the sale.
 * A queue that is missing or refusing the job comes back as a retryable
 * result and the spooler backs off.
 */
export class UsbPrinterAdapter implements PrinterAdapter {
  readonly id: string;
  readonly config: PrinterConnectionConfig;
  private readonly worker: RawPrintWorker;
  private connected = false;

  constructor(config: PrinterConnectionConfig, worker?: RawPrintWorker) {
    if (config.transport !== 'usb' || !config.usb?.printerName) {
      throw new Error('UsbPrinterAdapter requires transport=usb with a printer name');
    }
    this.id = uuidv7();
    this.config = config;
    this.worker =
      worker ??
      new RawPrintWorker(undefined, {
        onEvent: (message, meta) => log.info(`USB printer: ${message}`, meta ?? {}),
      });
  }

  /**
   * Start the print worker now: compiling its helper takes a moment, and a
   * cash-drawer pulse should not wait for that on the first sale. Resolves
   * once it is ready (callers that only want it started don't await it).
   */
  async connect(): Promise<void> {
    this.connected = true;
    await this.worker.whenReady();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.worker.dispose();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(bytes: Uint8Array, opts: SendOptions = {}): Promise<PrintResult> {
    const start = Date.now();
    const printerName = this.config.usb?.printerName;
    if (!printerName) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'no_config', message: 'No USB printer selected', recoverable: false },
      };
    }
    try {
      const written = await this.worker.send(printerName, bytes, {
        drawer: opts.drawer === true,
        ...(opts.notAfter !== undefined ? { notAfter: opts.notAfter } : {}),
      });
      log.info(opts.drawer ? 'USB printer took the drawer pulse' : 'USB printer job spooled', {
        printerName,
        bytes: written,
      });
      return { ok: true, durationMs: Date.now() - start };
    } catch (err) {
      const e =
        err instanceof RawPrintError
          ? err
          : new RawPrintError('usb_error', err instanceof Error ? err.message : String(err), true);
      log.warn('USB printer error', { printerName, code: e.code, err: e.message, drawer: opts.drawer === true });
      return {
        ok: false,
        durationMs: Date.now() - start,
        error: {
          code: e.code,
          message: e.message,
          recoverable: e.recoverable,
          ...(e.maybeSent ? { maybeSent: true } : {}),
        },
      };
    }
  }

  async testPrint(opts?: TestPageOptions): Promise<PrintResult> {
    return this.send(
      renderTestPage(this.config.width ?? 48, `USB: ${this.config.usb?.printerName ?? ''}`, opts),
    );
  }
}
