/**
 * Minimal ESC/POS command builder for thermal printers. The output is a raw
 * byte buffer that any 58mm or 80mm receipt printer with ESC/POS firmware can
 * consume — Epson TM-T20, Citizen CT-S310, generic XPrinter, etc.
 *
 * This file is PURE — no IO, no Electron, no Node. That makes it safe to use
 * in unit tests and (eventually) in a browser-side mock.
 */

import type { PrinterWidth } from '@cheeseoclock/shared-types';

// ESC/POS commands ------------------------------------------------------------
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const CR = 0x0d;

const INIT = [ESC, 0x40];
const ALIGN_LEFT = [ESC, 0x61, 0x00];
const ALIGN_CENTER = [ESC, 0x61, 0x01];
const ALIGN_RIGHT = [ESC, 0x61, 0x02];
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
const UNDERLINE_ON = [ESC, 0x2d, 0x01];
const UNDERLINE_OFF = [ESC, 0x2d, 0x00];
const DOUBLE_SIZE_ON = [GS, 0x21, 0x11];
const DOUBLE_HEIGHT_ON = [GS, 0x21, 0x01];
const NORMAL_SIZE = [GS, 0x21, 0x00];
const CUT_FULL = [GS, 0x56, 0x00];
const CUT_PARTIAL = [GS, 0x56, 0x01];
const DRAWER_KICK = [ESC, 0x70, 0x00, 0x19, 0xfa]; // open drawer 1
const FEED = (n: number) => [ESC, 0x64, n & 0xff];

// Code Page 437 (default) — most thermal printers expect single-byte ASCII;
// non-ASCII chars need transliteration. For Urdu/Arabic shop name, we'd swap
// in a Code Page (e.g. 864) and re-encode — left for Phase 3.5.

export class EscPosBuilder {
  private bytes: number[] = [];
  private readonly width: PrinterWidth;

  constructor(width: PrinterWidth = 48) {
    this.width = width;
    this.push(...INIT);
  }

  private push(...bs: number[]) {
    this.bytes.push(...bs);
    return this;
  }

  /** Append raw bytes — used by helpers like qrCode that emit multi-byte sequences. */
  appendRaw(bs: number[]): this {
    this.bytes.push(...bs);
    return this;
  }

  private writeAscii(s: string) {
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      // Drop anything outside printable ASCII to avoid gibberish on default codepage.
      this.bytes.push(code > 0 && code < 0x80 ? code : 0x3f /* '?' */);
    }
    return this;
  }

  align(side: 'left' | 'center' | 'right') {
    if (side === 'center') this.push(...ALIGN_CENTER);
    else if (side === 'right') this.push(...ALIGN_RIGHT);
    else this.push(...ALIGN_LEFT);
    return this;
  }

  bold(on: boolean) {
    return this.push(...(on ? BOLD_ON : BOLD_OFF));
  }
  underline(on: boolean) {
    return this.push(...(on ? UNDERLINE_ON : UNDERLINE_OFF));
  }
  doubleSize(on: boolean) {
    return this.push(...(on ? DOUBLE_SIZE_ON : NORMAL_SIZE));
  }
  doubleHeight(on: boolean) {
    return this.push(...(on ? DOUBLE_HEIGHT_ON : NORMAL_SIZE));
  }

  text(s: string) {
    return this.writeAscii(s);
  }

  newline(n = 1) {
    for (let i = 0; i < n; i++) this.push(LF);
    return this;
  }

  /** Print a label–value pair, padding to fill the configured width. */
  line(left: string, right = '') {
    const l = sanitizeAscii(left);
    const r = sanitizeAscii(right);
    const pad = Math.max(1, this.width - l.length - r.length);
    return this.writeAscii(l + ' '.repeat(pad) + r).newline();
  }

  /** Horizontal rule at the configured width. */
  rule(char = '-') {
    return this.writeAscii(char.repeat(this.width)).newline();
  }

  feed(n = 1) {
    return this.push(...FEED(n));
  }

  cut(partial = true) {
    return this.feed(3).push(...(partial ? CUT_PARTIAL : CUT_FULL));
  }

  openDrawer() {
    return this.push(...DRAWER_KICK);
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Strip non-ASCII so estimated lengths line up with what the printer prints. */
function sanitizeAscii(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?');
}

/**
 * Append an ESC/POS QR code to the builder. Uses the GS ( k command set
 * supported by every Epson-compatible thermal printer (Epson, Citizen,
 * Bixolon, XPrinter, etc).
 *
 * @param b      the builder to append to
 * @param data   QR payload (any text — FBR sends a URL string)
 * @param size   module size (cell size) from 1 to 16; 6 is a reasonable default
 */
export function qrCode(b: EscPosBuilder, data: string, size = 6): EscPosBuilder {
  const ascii: number[] = [];
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    ascii.push(code > 0 && code < 0x80 ? code : 0x3f);
  }

  // 1) Model — { GS ( k pL pH cn fn n1 n2 } with cn=0x31, fn=0x41, n1=50 (model 2), n2=0
  b.appendRaw([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
  // 2) Size — { GS ( k pL pH cn fn n } cn=0x31, fn=0x43, n=size
  b.appendRaw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, size))]);
  // 3) Error correction level — { GS ( k pL pH cn fn n } cn=0x31, fn=0x45, n=49 (M)
  b.appendRaw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]);
  // 4) Store data — { GS ( k pL pH cn fn m d1...dk } cn=0x31, fn=0x50, m=0x30
  const len = ascii.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  b.appendRaw([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...ascii]);
  // 5) Print — { GS ( k pL pH cn fn m } cn=0x31, fn=0x51, m=0x30
  b.appendRaw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);

  return b;
}

/** Wrap a long string to fit `width` columns, breaking on word boundaries. */
export function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  const words = s.split(/\s+/).filter(Boolean);
  let line = '';
  for (const w of words) {
    if (line.length + 1 + w.length <= width) {
      line = line ? `${line} ${w}` : w;
    } else {
      if (line) out.push(line);
      if (w.length > width) {
        // long word: hard-wrap
        for (let i = 0; i < w.length; i += width) out.push(w.slice(i, i + width));
        line = '';
      } else {
        line = w;
      }
    }
  }
  if (line) out.push(line);
  return out;
}
