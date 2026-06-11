// Removes a near-black background from your logo and writes a transparent PNG.
//
//   1. Save your logo into:  apps/web/public/logo-original.png   (or .jpg/.webp)
//   2. Run:                  pnpm --filter @cheeseoclock/web logo:clean
//   3. It writes:            apps/web/public/logo.png   (transparent)
//   4. Commit + push → Vercel deploys your exact logo, no black box.
//
// How it works: the logo is gold on black, so we set each pixel's transparency
// from its brightness — black background → fully transparent, gold artwork →
// fully opaque, with smooth anti-aliased edges. Your colours are untouched.
import { Jimp } from 'jimp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const candidates = ['logo-original.png', 'logo-original.jpg', 'logo-original.jpeg', 'logo-original.webp'];
const src = candidates.map((c) => path.join(pub, c)).find((p) => fs.existsSync(p));

if (!src) {
  console.error(
    'No source logo found.\nSave your logo as apps/web/public/logo-original.png first, then re-run.',
  );
  process.exit(1);
}

const img = await Jimp.read(src);
const { width, height, data } = img.bitmap;
// Brightness thresholds: <=LO is fully transparent, >=HI fully opaque, between
// is a smooth ramp so edges stay crisp.
const LO = 26;
const HI = 70;
for (let i = 0; i < data.length; i += 4) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const lum = Math.max(r, g, b);
  let a;
  if (lum <= LO) a = 0;
  else if (lum >= HI) a = 255;
  else a = Math.round(((lum - LO) / (HI - LO)) * 255);
  data[i + 3] = a;
}

await img.write(path.join(pub, 'logo.png'));
console.log(`Wrote public/logo.png — transparent, ${width}x${height}. Commit + push to deploy.`);
