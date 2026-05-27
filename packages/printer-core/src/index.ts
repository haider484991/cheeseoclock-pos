/**
 * PrinterAdapter — the abstract interface every printer implementation must
 * satisfy. Implementations live in apps/pos/electron/adapters/printer/* and
 * may use ESC/POS over USB, network, bluetooth, or serial.
 *
 * The renderer never sees implementations — it only sees PrinterAdapter via IPC.
 */

import type {
  PrinterConnectionConfig,
  PrinterTransport,
  PrinterStation,
  PrintResult,
  OrderSnapshot,
} from '@cheeseoclock/shared-types';

export type {
  PrinterConnectionConfig,
  PrinterTransport,
  PrinterStation,
  PrintResult,
};

export interface KOTContext {
  station: PrinterStation;
  orderShortId: string;
  /** Only print items whose menu item's prepStation matches `station`. */
  filterToStation: boolean;
}

export interface PrintReceiptOptions {
  copies?: number;
  cutPaper?: boolean;
  openDrawer?: boolean;
}

export interface PrinterAdapter {
  readonly id: string;
  readonly config: PrinterConnectionConfig;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Send raw ESC/POS bytes to the printer. The high-level renderer produces these. */
  send(bytes: Uint8Array): Promise<PrintResult>;
  testPrint(): Promise<PrintResult>;
}

export interface PrinterAdapterFactory {
  create(config: PrinterConnectionConfig): PrinterAdapter;
  /**
   * Discover candidate printers reachable over the given transport.
   * USB: enumerates connected devices. Network: optionally probes mDNS / known ports.
   * Bluetooth: lists paired devices (pairing happens in OS, not the app).
   */
  discover(transport: PrinterTransport): Promise<PrinterConnectionConfig[]>;
}

// Re-export the renderer + builder so consumers don't reach into subpaths.
export { EscPosBuilder, wrap, qrCode } from './escpos.js';
export { renderReceipt } from './receipt-renderer.js';
export type { RenderReceiptOpts, ReceiptBranding } from './receipt-renderer.js';
