import { useEffect, useRef, useState } from 'react';
import type { MonoRaster } from '@cheeseoclock/printer-core';
import type { PrinterWidth } from '@cheeseoclock/shared-types';
import { previewReceiptLogo, type LogoPreview } from './receiptLogo';

const NONE: LogoPreview = { state: 'none', raster: null, repaired: false };

/** What the receipt printer would make of `logoUrl` (saved or not yet saved), recomputed as it changes. */
export function useReceiptLogoPreview(logoUrl: string | null, paper: PrinterWidth): LogoPreview {
  const [preview, setPreview] = useState<LogoPreview>(NONE);
  useEffect(() => {
    if (!logoUrl) {
      setPreview(NONE);
      return;
    }
    let live = true;
    setPreview((p) => ({ ...p, state: 'loading' }));
    previewReceiptLogo(logoUrl, paper)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch((e: unknown) => {
        console.warn('Logo preview failed', e);
        if (live) setPreview({ state: 'error', raster: null, repaired: false });
      });
    return () => {
      live = false;
    };
  }, [logoUrl, paper]);
  return preview;
}

/**
 * The logo's dots, black on white. `paperDots` given: drawn at its share of
 * the paper's width (for a scaled receipt). Without it: one screen pixel per
 * printer dot, crisp, the size it really is.
 */
export function PrintedLogo({ raster, paperDots }: { raster: MonoRaster; paperDots?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    const img = ctx.createImageData(raster.width, raster.height);
    const bpr = raster.width / 8;
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const on = ((raster.data[y * bpr + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
        const i = (y * raster.width + x) * 4;
        const v = on ? 0 : 255;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [raster]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="Logo as printed"
      className="mx-auto block max-w-none"
      style={
        paperDots
          ? { width: `${(raster.width / paperDots) * 100}%`, height: 'auto' }
          : { width: raster.width, height: raster.height, imageRendering: 'pixelated' }
      }
    />
  );
}
