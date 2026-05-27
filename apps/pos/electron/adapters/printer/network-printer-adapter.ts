import { Socket } from 'node:net';
import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type {
  PrinterAdapter,
  PrintResult,
  PrinterConnectionConfig,
} from '@cheeseoclock/printer-core';
import { renderTestPage } from './test-page.js';

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

  async send(bytes: Uint8Array): Promise<PrintResult> {
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
      const done = (result: PrintResult) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(timeoutMs);
      socket.once('error', (err) => {
        log.warn('Network printer error', { host: net.host, port: net.port, err: err.message });
        done({
          ok: false,
          durationMs: Date.now() - start,
          error: { code: 'network_error', message: err.message, recoverable: true },
        });
      });
      socket.once('timeout', () => {
        log.warn('Network printer timeout', { host: net.host, port: net.port, timeoutMs });
        done({
          ok: false,
          durationMs: Date.now() - start,
          error: {
            code: 'timeout',
            message: `Printer did not respond within ${timeoutMs}ms`,
            recoverable: true,
          },
        });
      });
      socket.connect(net.port, net.host, () => {
        socket.write(Buffer.from(bytes), (writeErr) => {
          if (writeErr) {
            done({
              ok: false,
              durationMs: Date.now() - start,
              error: { code: 'write_error', message: writeErr.message, recoverable: true },
            });
            return;
          }
          // Give the printer a moment to consume the buffer, then close cleanly.
          socket.end(() => {
            done({ ok: true, durationMs: Date.now() - start });
          });
        });
      });
    });
  }

  async testPrint(): Promise<PrintResult> {
    return this.send(renderTestPage(this.config.width ?? 48));
  }
}
