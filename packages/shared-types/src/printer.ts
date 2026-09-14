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

/** Which copy of a receipt is being printed. The shop copy carries a signature line. */
export type ReceiptCopy = 'customer' | 'shop';

/** When a second, SHOP COPY receipt prints alongside the customer's. */
export type ShopCopyRule = 'never' | 'delivery' | 'always';

/**
 * What prints automatically, and when. Set under Settings → Printer.
 *
 *  - Kitchen ticket: no prices; printed once, the moment an order is sent to
 *    the kitchen (Send to kitchen, Pay now at the counter, or a website order
 *    arriving). Goes to the kitchen printer if one is set up, otherwise the
 *    receipt printer.
 *  - Customer receipt: printed when money is taken — Pay now, or a
 *    cash-on-delivery order marked served / delivered with its payment. A
 *    cash payment pops the drawer.
 *  - Delivery bill: for delivery orders, the bill prints when the rider is
 *    assigned so it travels with the food, showing the amount to collect (or
 *    PAID). When the rider brings the cash back, only the drawer opens — the
 *    customer already has the receipt.
 *  - Shop copy: a second copy marked SHOP COPY with a "Received by" line,
 *    printed with every delivery bill (default), every receipt, or never.
 */
export interface PrintPolicy {
  kitchenTicket: boolean;
  deliveryBillOnDispatch: boolean;
  shopCopy: ShopCopyRule;
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
