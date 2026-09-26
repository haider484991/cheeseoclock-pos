/**
 * Turns an ESC/POS byte stream back into the rows a printer would put on
 * paper. It understands exactly the commands EscPosBuilder and qrCode emit,
 * which is enough for two jobs: the mock printer's human-readable .txt, and
 * tests that assert on what a receipt looks like rather than on bytes.
 *
 * Pure, like the builder.
 */

export interface DecodedLine {
  text: string;
  /** 2 while double-width is on (GS ! with the width bit) — each char takes two columns. */
  scale: 1 | 2;
}

/** Row that stands in for a paper cut in the decoded output. */
export const CUT_MARKER = '[cut]';
/** Row that stands in for a printed QR code in the decoded output. */
export const QR_MARKER = '[QR]';

/** Row that stands in for a cash-drawer pulse, e.g. "[drawer pin 2, 50 ms]". */
export const drawerMarker = (pin: number, ms: number): string => `[drawer pin ${pin}, ${ms} ms]`;

/** Row that stands in for a printed picture (the logo), e.g. "[logo 576×160]". */
export const logoMarker = (width: number, height: number): string => `[logo ${width}×${height}]`;

const ESC = 0x1b;
const GS = 0x1d;

export function decodeEscPos(bytes: Uint8Array): DecodedLine[] {
  const lines: DecodedLine[] = [];
  let cur = '';
  let scale: 1 | 2 = 1;
  /** The picture row being built: bands of one picture sent back to back merge into it. */
  let raster: { line: DecodedLine; width: number; height: number } | null = null;
  const flush = () => {
    lines.push({ text: cur, scale });
    cur = '';
  };
  const flushIfPending = () => {
    if (cur) flush();
  };

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;

    if (b === ESC) {
      const c = bytes[i + 1];
      if (c === 0x40) {
        // ESC @ — initialise
        scale = 1;
        i += 1;
      } else if (c === 0x64) {
        // ESC d n — print and feed n lines
        flushIfPending();
        const n = bytes[i + 2] ?? 0;
        for (let k = 0; k < n; k++) lines.push({ text: '', scale });
        i += 2;
      } else if (c === 0x70) {
        // ESC p m t1 t2 — drawer pulse: m 0/48 is pin 2, 1/49 pin 5; t1 in 2 ms steps
        flushIfPending();
        const pin = (bytes[i + 2] ?? 0) & 1 ? 5 : 2;
        lines.push({ text: drawerMarker(pin, (bytes[i + 3] ?? 0) * 2), scale: 1 });
        i += 4;
      } else if (c === 0x61 || c === 0x45 || c === 0x2d || c === 0x4a) {
        // ESC a/E/-/J n — align, bold, underline, feed dots
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (b === GS) {
      const c = bytes[i + 1];
      if (c === 0x21) {
        // GS ! n — character size; bit 4 doubles the width
        const n = bytes[i + 2] ?? 0;
        scale = n & 0x10 ? 2 : 1;
        i += 2;
      } else if (c === 0x56) {
        // GS V m [n] — cut; 65/66 carry a feed argument
        flushIfPending();
        const m = bytes[i + 2] ?? 0;
        lines.push({ text: CUT_MARKER, scale: 1 });
        i += m === 0x41 || m === 0x42 ? 3 : 2;
      } else if (c === 0x28 && bytes[i + 2] === 0x6b) {
        // GS ( k pL pH cn fn … — 2D code functions; only "print" puts ink down
        const len = (bytes[i + 3] ?? 0) | ((bytes[i + 4] ?? 0) << 8);
        if (bytes[i + 6] === 0x51) {
          flushIfPending();
          lines.push({ text: QR_MARKER, scale: 1 });
        }
        i += 4 + len;
      } else if (c === 0x76 && bytes[i + 2] === 0x30) {
        // GS v 0 m xL xH yL yH d1…dk — raster picture, k = x·y bytes of dots.
        // The data is dots, not text or commands: skip it whole.
        flushIfPending();
        const x = (bytes[i + 4] ?? 0) | ((bytes[i + 5] ?? 0) << 8);
        const y = (bytes[i + 6] ?? 0) | ((bytes[i + 7] ?? 0) << 8);
        if (raster && lines.at(-1) === raster.line && raster.width === x * 8) {
          raster.height += y;
          raster.line.text = logoMarker(raster.width, raster.height);
        } else {
          const line: DecodedLine = { text: logoMarker(x * 8, y), scale: 1 };
          lines.push(line);
          raster = { line, width: x * 8, height: y };
        }
        i += 7 + x * y;
      } else {
        i += 1;
      }
      continue;
    }

    if (b === 0x0a) {
      flush();
      continue;
    }
    if (b === 0x0d) continue;
    cur += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?';
  }
  flushIfPending();
  return lines;
}

/** The decoded rows joined with newlines — what the mock printer writes out. */
export function escPosToText(bytes: Uint8Array): string {
  return decodeEscPos(bytes)
    .map((l) => l.text)
    .join('\n');
}
