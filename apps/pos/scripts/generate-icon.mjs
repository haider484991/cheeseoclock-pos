/**
 * Generates apps/pos/build/icon.ico from apps/pos/build/icon.svg.
 *
 * electron-builder picks up `build/icon.ico` automatically for the Windows
 * installer, the .exe shortcut, the taskbar, and the title-bar icon.
 *
 * Run with:  pnpm --filter @cheeseoclock/pos gen:icon
 *
 * For a per-customer build, swap apps/pos/build/icon.svg before running this
 * script — every install of THAT build will then carry the customer's logo.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SVG_PATH = resolve(__dirname, '..', 'build', 'icon.svg');
const OUT_DIR = resolve(__dirname, '..', 'build');
const ICO_PATH = resolve(OUT_DIR, 'icon.ico');
const PNG_PATH = resolve(OUT_DIR, 'icon.png');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const svg = readFileSync(SVG_PATH);

// Render each size from the SVG at its native viewBox, then bundle into one .ico.
const pngBuffers = SIZES.map((size) => {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return Buffer.from(resvg.render().asPng());
});

mkdirSync(OUT_DIR, { recursive: true });

// Also write a 256px PNG (used by Linux + by the about screen).
writeFileSync(PNG_PATH, pngBuffers[pngBuffers.length - 1]);

const ico = await pngToIco(pngBuffers);
writeFileSync(ICO_PATH, ico);

console.log(`✓ ${ICO_PATH} (${SIZES.length} sizes)`);
console.log(`✓ ${PNG_PATH}`);
