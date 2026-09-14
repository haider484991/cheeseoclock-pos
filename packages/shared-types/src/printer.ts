/** Printer transport + connection config shared between POS and printer-core. */

export type PrinterTransport = 'usb' | 'network' | 'bluetooth' | 'serial';
export type PrinterStation = 'receipt' | 'kitchen' | 'bar' | 'cold';
export type PrinterWidth = 32 | 48; // 58mm or 80mm

export interface PrinterConnectionConfig {
  transport: PrinterTransport;
  /**
   * USB printers are driven through the operating system's print queue — on
   * Windows, the printer as it appears under Settings → Printers & scanners.
   * The OS owns the USB port; we hand it our ESC/POS bytes as a RAW job.
   * `printerName` is that queue's name. vendorId/productId are reserved for a
   * future direct-libusb path and are not used today.
   */
  usb?: { printerName: string; vendorId?: number; productId?: number };
  network?: { host: string; port: number; timeoutMs?: number };
  bluetooth?: { address: string; channel?: number };
  serial?: { path: string; baudRate?: number };
  codepage?: string;
  width?: PrinterWidth;
}

export interface PrinterAssignment {
  id: string;
  station: PrinterStation;
  config: PrinterConnectionConfig;
  isActive: boolean;
}

export interface PrintResult {
  ok: boolean;
  durationMs: number;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

/** A printer queue installed in the operating system, for the USB picker. */
export interface SystemPrinterInfo {
  /** Queue name — what goes in `PrinterConnectionConfig.usb.printerName`. */
  name: string;
  displayName: string;
  isDefault: boolean;
  /**
   * Best guess that this is a receipt printer rather than a PDF / fax / XPS
   * queue. Only affects ordering and the default pick in the settings form.
   */
  likelyReceiptPrinter: boolean;
}
