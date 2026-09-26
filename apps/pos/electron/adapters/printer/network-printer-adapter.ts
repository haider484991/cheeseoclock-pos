import { Socket } from 'node:net';
import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import {
  DLE_EOT_PRINTER_STATUS,
  statusByteSaysOffline,
  type PrinterAdapter,
  type PrintResult,
  type PrinterConnectionConfig,
  type SendOptions,
  type TestPageOptions,
} from '@cheeseoclock/printer-core';
import { DRAWER_TOO_LATE_CODE } from '@cheeseoclock/shared-types';
import { renderTestPage } from './test-page.js';

/** How long to wait for the printer's answer to "are you online?" before a drawer pulse. */
const STATUS_WAIT_MS = 300;

/**
 * Raw TCP printer adapter — works with the vast majority of network-capable
 * thermal printers (Epson TM-T20III LAN, Citizen CT-S310 LAN, XPrinter LAN, etc).
 * Default port for ESC/POS over LAN is 9100.
 *
 * Note: we open a fresh socket per print job. Persistent connections are
 * fragile across printer power cycles and risk leaving the printer "busy"
 * if the app crashes mid-print.
 */
export class NetworkPrinterAdapter implements PrinterAdapter {
  readonly id: string;
  readonly config: PrinterConnectionConfig;
  private connected = false;

  constructor(config: PrinterConnectionConfig) {
    if (config.transport !== 'network' || !config.network) {
      throw new Error('NetworkPrinterAdapter requires transport=network');
    }
    this.id = uuidv7();
    this.config = config;
  }

  async connect(): Promise<void> {
    // No persistent connection — we open per-job. We just mark ready.
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * One socket per job. For a drawer pulse, two extra rules: the printer is
   * asked first whether it is online (DLE EOT 1 — a printer with its lid open
   * or out of paper would keep the pulse and pop the drawer when it
   * recovers), and a failure after the bytes started going out says
   * `maybeSent`, so the pulse is never sent a second time.
   */
  async send(bytes: Uint8Array, opts: SendOptions = {}): Promise<PrintResult> {
    const start = Date.now();
    const net = this.config.network;
    if (!net) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'no_config', message: 'No network config', recoverable: false },
      };
    }
    const timeoutMs = net.timeoutMs ?? 5000;

    return new Promise<PrintResult>((resolve) => {
      const socket = new Socket();
      let finished = false;
      /** The job's own bytes began to go out (the status question doesn't count). */
      let started = false;
      const done = (result: PrintResult) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolve(result);
      };
      const fail = (code: string, message: string, recoverable: boolean) =>
        done({
          ok: false,
          durationMs: Date.now() - start,
          error: { code, message, recoverable, ...(started ? { maybeSent: true } : {}) },
        });

      socket.setTimeout(timeoutMs);
      socket.once('error', (err) => {
        log.warn('Network printer error', { host: net.host, port: net.port, err: err.message, started });
        fail('network_error', err.message, true);
      });
      socket.once('timeout', () => {
        log.warn('Network printer timeout', { host: net.host, port: net.port, timeoutMs, started });
        fail('timeout', `Printer did not respond within ${timeoutMs}ms`, true);
      });

      const write = () => {
        if (finished) return;
        if (opts.notAfter !== undefined && Date.now() > opts.notAfter) {
          fail(DRAWER_TOO_LATE_CODE, 'The printer was not ready in time', false);
          return;
        }
        started = true;
        socket.write(Buffer.from(bytes), (writeErr) => {
          if (writeErr) {
            fail('write_error', writeErr.message, true);
            return;
          }
          // Give the printer a moment to consume the buffer, then close cleanly.
          socket.end(() => {
            done({ ok: true, durationMs: Date.now() - start });
          });
        });
      };

      socket.connect(net.port, net.host, () => {
        if (!opts.drawer) {
          write();
          return;
        }
        // Ask first. No answer (printers without real-time status) → send as
        // before; a clear "offline" → don't send, and let the till retry.
        const timer = setTimeout(() => {
          socket.removeListener('data', onData);
          write();
        }, STATUS_WAIT_MS);
        const onData = (chunk: Buffer) => {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          const b = chunk[0];
          if (b !== undefined && statusByteSaysOffline(b)) {
            log.warn('Network printer says it is offline; drawer pulse not sent', { host: net.host, status: b });
            fail('printer_offline', 'It says it is offline (lid open, out of paper or an error).', true);
            return;
          }
          write();
        };
        socket.on('data', onData);
        socket.write(Buffer.from(DLE_EOT_PRINTER_STATUS));
      });
    });
  }

  async testPrint(opts?: TestPageOptions): Promise<PrintResult> {
    const net = this.config.network;
    const label = net ? `LAN ${net.host}:${net.port}` : 'LAN';
    return this.send(renderTestPage(this.config.width ?? 48, label, opts));
  }
}
