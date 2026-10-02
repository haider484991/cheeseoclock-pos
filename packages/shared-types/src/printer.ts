/** Printer transport + connection config shared between POS and printer-core. */

import { SHIFT_REPORT_SECTIONS, type ShiftReportSection } from './shift-report.js';

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
  /**
   * The cash drawer plugged into this printer's drawer port (receipt printer
   * only). Missing means the usual pin 2, 50 ms.
   */
  drawer?: DrawerSettings;
}

/**
 * How the printer pulses the cash drawer: which pin of its drawer port (DK)
 * and how long. Almost every drawer opens on pin 2 with 50 ms; a stiff 24 V
 * solenoid may want 100 ms. Never longer — a long pulse can burn the coil.
 */
export interface DrawerSettings {
  pin: 2 | 5;
  pulseMs: 50 | 100;
}

export const DEFAULT_DRAWER_SETTINGS: DrawerSettings = { pin: 2, pulseMs: 50 };

/**
 * `printer:failed` error codes for the cash drawer. NOT_OPENED: it did not
 * open (use the key). UNSURE: the printer had a problem mid-way, so it may or
 * may not have opened — and must not be sent again.
 */
export const DRAWER_NOT_OPENED_CODE = 'drawer_not_opened';
export const DRAWER_UNSURE_CODE = 'drawer_unsure';
/** A drawer pulse that could not go out in time and was not sent (it would pop late). */
export const DRAWER_TOO_LATE_CODE = 'drawer_too_late';

/** Which copy of a receipt is being printed. The shop copy carries a signature line. */
export type ReceiptCopy = 'customer' | 'shop';

/**
 * A paper the till printed for an order, as kept in the print log
 * (document_prints): the customer receipt (PAID), a bill (NOT PAID), a refund
 * slip, a cancelled-order slip, the kitchen ticket, the kitchen CANCELLED slip,
 * and (v0.7.36) the kitchen's ADDED / REMOVED slip of an Edit order — one
 * series per edit (doc key `kitchen_change:<n>`).
 */
export type PrintedDocument = 'receipt' | 'bill' | 'refund' | 'void' | 'kitchen' | 'kitchen_cancel' | 'kitchen_change';

/**
 * What a print button did:
 *  - queued: a new paper is on its way (`duplicate`: it says DUPLICATE —
 *    always, for a customer paper printed by hand; `printNo` papers of this
 *    document went out before it);
 *  - merged: that paper was still waiting to print (the printer is busy or
 *    retrying), so it was sent now instead of printing a second one.
 * For a kitchen ticket `duplicate` means it says REPRINT / DO NOT COOK TWICE
 * (a ticket surely printed before); `resent` that the earlier tries only may
 * have printed, so it says RE-SENT / CHECK FOR TICKET BEFORE COOKING.
 */
export interface ReprintResult {
  status: 'queued' | 'merged';
  document: PrintedDocument;
  duplicate: boolean;
  printNo: number;
  resent?: boolean;
  /**
   * The number the paper will carry ("Reprint #N"). Set on a queued
   * customer paper: 1 for the first hand press of a paper the till never
   * printed by itself.
   */
  reprintNo?: number;
}

/**
 * The rule every customer paper follows (the owner, 27 Sep 2026; shown in
 * Settings → Printing rules and kept in the code's comments): a paper's
 * SERIES is the order + what it is when it prints (BILL, RECEIPT, CANCELLED
 * ORDER, REFUND <time>) + which copy (customer or shop), counted across both
 * tills. The paper the till prints BY ITSELF (the receipt at Pay, or when
 * an order is paid as it is served or handed over; the delivery bill when the
 * rider leaves; the refund slip) is the ORIGINAL. The till never prints a
 * customer paper at Send or when a website order arrives. EVERY paper printed
 * with a print button says DUPLICATE with its reprint number, time and who —
 * even the first of its kind, so a bill asked for before payment always
 * does. Only a failed automatic job sent again (the till's own retry, or
 * "Try again" on the failed-print note) is still the original. A paid
 * RECEIPT after a BILL is a new series (it carries the FBR number).
 */

/** How one printed paper is marked, in the words the order panel shows. */
export type OrderPaperLabel =
  | 'Original'
  | 'Printed later'
  | `Reprint #${number}`
  | `Copy #${number}`
  | 'Printer retry'
  | 'RE-SENT'
  | 'May have printed';

/** One paper in an order's print log, oldest first (either till). */
export interface OrderPaperLine {
  /** When it printed (ISO). */
  at: string;
  document: PrintedDocument;
  copy: ReceiptCopy | 'kitchen';
  label: OrderPaperLabel;
  /** It said DUPLICATE (a customer paper) or REPRINT / RE-SENT (a kitchen ticket). */
  duplicate: boolean;
  /** Who asked (who pressed the button; for an automatic paper, who was signed in). */
  byName: string | null;
  approvedByName: string | null;
  /** payment, dispatch, refund, reprint (by hand), auto (kitchen), cancel. */
  reason: string;
  /** Printed on the other till. */
  otherTill: boolean;
}

/**
 * What the print button of an order would print now, and every paper the
 * order had (the order panel's "Papers printed"). `next` is null for an
 * order still being rung up (there is nothing to print yet).
 */
export interface OrderPapers {
  next: {
    document: 'bill' | 'receipt' | 'void';
    /** Papers of that series so far (0: none printed yet). A press prints a DUPLICATE either way. */
    printedBefore: number;
    /** The number the press's paper will carry ("Reprint #N"). */
    reprintNo: number;
    /** A paper of that series is still waiting to print: a press joins it. */
    waiting: boolean;
    /**
     * The till's own paper for this order (the receipt at payment, the bill
     * when the rider left…) failed to print and nothing was printed since:
     * the print job to send again (printer:retryJob) — it prints as the
     * ORIGINAL, where the print button would print a DUPLICATE. Null: none.
     */
    failedJobId?: string | null;
  } | null;
  papers: OrderPaperLine[];
}

/**
 * A reprint refused until a manager allows it: the IPC error is 'forbidden'
 * with these details, and the screen asks for a manager's PIN or password.
 */
export const NEEDS_MANAGER_PIN = 'manager_pin';

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
 *  - Delivery bill: for delivery orders the bill prints when the order goes
 *    out — Send out, or Assign rider — so it travels with the food and shows
 *    the amount to collect, or PAID. It prints once per order, on either
 *    till. When the rider brings the money back, only the drawer opens.
 *  - Shop copy: a second copy marked SHOP COPY with a "Received by" line,
 *    printed with every delivery bill (default), every receipt, or never.
 */
export interface PrintPolicy {
  kitchenTicket: boolean;
  /** The delivery bill when the order goes out (Send out, or Assign rider): "Print the bill when the order goes out". */
  deliveryBillOnDispatch: boolean;
  shopCopy: ShopCopyRule;
  /** Print the shop logo at the top of customer receipts (never on kitchen tickets). */
  logoOnReceipt: boolean;
  // The kitchen ticket's own rules (Settings → Printers, this till only:
  // each till drives its own printers). Not there = the released ones
  // (DEFAULT_KITCHEN_TICKET_RULES): read with kitchenTicketRules(). A policy
  // saved before they existed reads unchanged.
  /** Kitchen tickets per order, 1–3 (each says COPY 1 OF 2…; a ticket printed by hand is one). */
  kitchenCopies?: number;
  /** The customer's phone on the kitchen ticket. */
  kitchenPhone?: boolean;
  /** Drinks on the kitchen ticket; off, they are left off (an order of only drinks prints no ticket). */
  kitchenDrinks?: boolean;
  // The shift report's rules (Settings → Printers → Shift report; owner,
  // 2 Oct 2026): this till only, the owner's alone to change. Not there = on,
  // every section, every item: read with shiftReportRules(). A policy saved
  // before they existed reads unchanged. They change only what PRINTS: the
  // report saved at the close always holds every section.
  /** Print the shift report on the receipt printer when a shift closes. */
  shiftReportOnClose?: boolean;
  /** The sections on the paper: a section set to false is left off; one not there prints. */
  shiftReportSections?: Partial<Record<ShiftReportSection, boolean>>;
  /** ITEMS SOLD as every item under its category ('items'), or the category totals only. */
  shiftReportItems?: ShiftReportItemsShown;
}

/** How ITEMS SOLD prints: every item under its category, or the category totals only. */
export type ShiftReportItemsShown = 'items' | 'categories';

/** What the shift report paper carries on this till (PrintPolicy's shift report fields, read with their defaults). */
export interface ShiftReportRules {
  /** It prints when a shift closes. */
  onClose: boolean;
  /** Every one of the nine sections, true where it prints. */
  sections: Record<ShiftReportSection, boolean>;
  items: ShiftReportItemsShown;
}

/**
 * The shift report's rules on this till: what is saved, and for anything
 * not saved (or not readable) what the owner chose for every till at first —
 * printed at every close, every section on, every item listed.
 */
export function shiftReportRules(
  p: Pick<PrintPolicy, 'shiftReportOnClose' | 'shiftReportSections' | 'shiftReportItems'> | null | undefined,
): ShiftReportRules {
  const saved = p?.shiftReportSections;
  const sections = {} as Record<ShiftReportSection, boolean>;
  for (const { key } of SHIFT_REPORT_SECTIONS) {
    const on = saved && typeof saved === 'object' ? saved[key] : undefined;
    sections[key] = typeof on === 'boolean' ? on : true;
  }
  return {
    onClose: typeof p?.shiftReportOnClose === 'boolean' ? p.shiftReportOnClose : true,
    sections,
    items: p?.shiftReportItems === 'categories' ? 'categories' : 'items',
  };
}

/** What a kitchen ticket carries, and how many print (PrintPolicy's kitchen fields, read with their defaults). */
export interface KitchenTicketRules {
  copies: number;
  phone: boolean;
  drinks: boolean;
}

/** The most kitchen tickets one order prints. */
export const KITCHEN_COPIES_MAX = 3;

/** Today: one kitchen ticket, with the customer's phone and every item, drinks too. Released: never edited. */
export const DEFAULT_KITCHEN_TICKET_RULES: Readonly<KitchenTicketRules> = Object.freeze({ copies: 1, phone: true, drinks: true });

/** The kitchen ticket's rules on this till: what is saved, the released ones for what is not. */
export function kitchenTicketRules(p: Pick<PrintPolicy, 'kitchenCopies' | 'kitchenPhone' | 'kitchenDrinks'> | null | undefined): KitchenTicketRules {
  const copies = p?.kitchenCopies;
  return {
    copies:
      typeof copies === 'number' && Number.isInteger(copies) && copies >= 1 && copies <= KITCHEN_COPIES_MAX
        ? copies
        : DEFAULT_KITCHEN_TICKET_RULES.copies,
    phone: typeof p?.kitchenPhone === 'boolean' ? p.kitchenPhone : DEFAULT_KITCHEN_TICKET_RULES.phone,
    drinks: typeof p?.kitchenDrinks === 'boolean' ? p.kitchenDrinks : DEFAULT_KITCHEN_TICKET_RULES.drinks,
  };
}

/** One line of the kitchen's CHANGE slip (Edit order, v0.7.36): what was added or taken off. */
export interface KitchenChangeLine {
  name: string;
  /** How many were added or taken off (not the line's new quantity). */
  quantity: number;
  /** Its choices as the kitchen reads them ("No onion", "Extra cheese"…). */
  modifiers: string[];
  notes: string | null;
  /** A drink (the bar, or a Drinks category): left off when this till leaves drinks off its tickets. */
  drink: boolean;
}

/**
 * What an Edit order changed, as the kitchen's CHANGE slip prints it (v0.7.36;
 * the owner, 2 Oct 2026: "ADDED / REMOVED kitchen slips"). Frozen in the
 * print job when the edit is saved: the slip says what changed then, never
 * the order as it is when the printer gets to it.
 */
export interface KitchenChange {
  /** The order's nth edit (its paper series: `kitchen_change:<n>`). */
  editNo: number;
  /** When the edit was saved (ISO). */
  at: string;
  /** Who saved it. */
  byUserId: string | null;
  /** Why, when something came off. */
  reason: string | null;
  added: KitchenChangeLine[];
  removed: KitchenChangeLine[];
}

/** The logo as a 1-bit picture for one paper width, as stored and sent over IPC. */
export interface ReceiptLogoRasterJson {
  paperWidth: PrinterWidth;
  /** Dots across (a multiple of 8) and rows down. */
  width: number;
  height: number;
  /** Base64 of the packed dots: width/8 bytes a row, leftmost dot in the high bit, 1 = black. */
  data: string;
}

/**
 * The printer's copy of the shop logo, made on screen from the saved logo.
 * Kept beside the branding (not inside it) and tied to the exact logo it came
 * from, so a picture of an older logo can never print.
 */
export interface ReceiptLogoRasterSet {
  /** logoFingerprint() of the logo data URL it was made from. */
  source: string;
  /** LOGO_RASTER_ALGO it was made with; a newer till redraws older ones. */
  algo: number;
  /** One per paper width; a width is missing when nothing on it would print. */
  rasters: ReceiptLogoRasterJson[];
}

/**
 * What happens to the logo on the receipt printer:
 *  - none: no logo is set;
 *  - not_ready: the printer's copy isn't made yet (or is of an older logo);
 *  - blank: the logo is too light — nothing would print;
 *  - too_dark: it would print as a big black block, so it is left off;
 *  - ready: it prints (when the setting is on).
 */
export type ReceiptLogoState = 'none' | 'not_ready' | 'blank' | 'too_dark' | 'ready';

export interface ReceiptLogoStatus {
  /** For the receipt printer's paper width. */
  state: ReceiptLogoState;
  /** PrintPolicy.logoOnReceipt. */
  enabled: boolean;
  /** Which logo the stored printer copy was made from (no picture data), or null. */
  stored: { source: string; algo: number } | null;
  /** A test print that included this logo went through on this printer. */
  checked: boolean;
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
    /**
     * The bytes may have reached the printer (e.g. a timeout after sending
     * began). A job carrying a drawer pulse is then never sent again: the
     * drawer may already be open, and a second pulse would open it twice.
     */
    maybeSent?: boolean;
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

/**
 * A plain paper that is not about an order (the recipe calculator's prep
 * list): a title, a few lines under it, then sections of rows — a name on
 * the left, an amount on the right, a note under it. One model for the
 * receipt printer (printer-core renderPlainDocument) and for "Copy as
 * text", so both say the same. Never carries a price.
 */
export interface PlainDocument {
  title: string;
  /** Under the title: when, by whom, what for. */
  subtitle: string[];
  sections: PlainDocumentSection[];
  /** At the bottom, after a rule. */
  footer: string[];
}

export interface PlainDocumentSection {
  heading: string;
  /** A line under the heading ("each batch made once"). */
  note?: string;
  rows: PlainDocumentRow[];
}

export interface PlainDocumentRow {
  /** Left: what it is. */
  text: string;
  /** Right: how much. */
  qty?: string;
  /** Under it, indented: "SHORT 400 g", "1.08 batches of 740 g". */
  notes?: string[];
  /** 0 = a main row; 1+ = inside the row above (a batch's inputs). */
  indent?: number;
  /** Printed bold (a recipe asked, a batch to make). */
  strong?: boolean;
}
