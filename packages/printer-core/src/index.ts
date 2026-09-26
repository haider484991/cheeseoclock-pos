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
} from '@cheeseoclock/shared-types';
import type { MonoRaster } from './logo-raster.js';

export type { PrinterConnectionConfig, PrinterTransport, PrinterStation, PrintResult };

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

/** What a test page shows about the shop logo (receipt printer only). */
export interface TestPageOptions {
  /** The logo as made for this paper; printed at the top when usable. */
  logo?: MonoRaster | null;
  /** One short line after "Logo" saying what happened to it, e.g. "should be above". */
  logoNote?: string;
  /** Whether receipts print the logo (the setting), shown when a logo is set. */
  logoOnReceipts?: boolean;
}

export interface PrinterAdapter {
  readonly id: string;
  readonly config: PrinterConnectionConfig;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Send raw ESC/POS bytes to the printer. The high-level renderer produces these. */
  send(bytes: Uint8Array): Promise<PrintResult>;
  testPrint(opts?: TestPageOptions): Promise<PrintResult>;
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
export {
  EscPosBuilder,
  wrap,
  qrCode,
  toPrinterAscii,
  LINES_BEFORE_CUT,
  RASTER_BAND_ROWS,
} from './escpos.js';
export { decodeEscPos, escPosToText, CUT_MARKER, QR_MARKER, logoMarker } from './escpos-decode.js';
export type { DecodedLine } from './escpos-decode.js';
export {
  renderReceipt,
  renderKitchenTicket,
  renderDrawerKick,
  appendLogo,
  LOGO_GAP_DOTS,
} from './receipt-renderer.js';
export {
  LOGO_RASTER_ALGO,
  LOGO_BOX,
  LOGO_MAX_INK_SHARE,
  logoBox,
  pixelDarkness,
  inkBounds,
  removeDarkBackdrop,
  dropStraySpecks,
  extractLogoInk,
  fitLogo,
  darknessToMonoRaster,
  rasteriseLogoInk,
  rasteriseLogo,
  isValidMonoRaster,
  rasterHasInk,
  inkShare,
  judgeLogoRaster,
  isPrintableLogo,
  centreOnPaper,
  logoFingerprint,
} from './logo-raster.js';
export type {
  MonoRaster,
  LogoBox,
  LogoFit,
  LogoInk,
  LogoInkOptions,
  LogoRasterVerdict,
} from './logo-raster.js';
export type {
  RenderReceiptOpts,
  RenderKitchenTicketOpts,
  ReceiptBranding,
} from './receipt-renderer.js';
