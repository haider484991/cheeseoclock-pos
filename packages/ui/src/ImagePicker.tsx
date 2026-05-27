import { useRef, useState } from 'react';
import { cn } from './cn.js';

interface Props {
  /** Current image as a data URL (or null). */
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  /** Max dimension (px) — image is resized to fit within a square of this size while preserving aspect ratio. */
  maxSize?: number;
  /** Output quality 0..1 for JPEG. */
  quality?: number;
  /** CSS classes for the preview area. */
  className?: string;
  /** Show the "Remove" button. */
  removable?: boolean;
  /** Round preview as a circle (for logos / avatars). */
  rounded?: boolean;
  /** Label shown when empty. */
  emptyLabel?: string;
}

/**
 * Image picker that loads a file from disk, resizes it to a sane web size,
 * and emits a data URL. Data URLs are stored in SQLite directly — keeps the
 * implementation portable and survives sync. For thumbnails (≤400px square,
 * JPEG ~80%) the typical size is 20–60KB which is fine for SQLite.
 */
export function ImagePicker({
  value,
  onChange,
  maxSize = 400,
  quality = 0.85,
  className,
  removable = true,
  rounded = false,
  emptyLabel = 'Click to upload',
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await resizeImage(file, maxSize, quality);
      onChange(dataUrl);
    } catch (err) {
      console.error('Image resize failed', err);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={cn(
          'group relative flex items-center justify-center overflow-hidden bg-stone-100 ring-1 ring-stone-200 transition-all hover:ring-amber-400 dark:bg-stone-800 dark:ring-stone-700',
          rounded ? 'h-20 w-20 rounded-full' : 'h-20 w-20 rounded-xl',
        )}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt=""
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <span className="px-2 text-center text-[10px] font-medium text-stone-500">
            {busy ? 'Resizing…' : emptyLabel}
          </span>
        )}
        {!busy && value && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
            Replace
          </span>
        )}
      </button>

      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="text-xs font-semibold text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-300"
        >
          {value ? 'Change' : 'Upload image'}
        </button>
        {value && removable && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-stone-500 hover:text-red-600"
          >
            Remove
          </button>
        )}
        <span className="text-[10px] text-stone-400">PNG / JPG · auto-resized</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={onFile}
      />
    </div>
  );
}

/**
 * Resize an image file to fit within maxSize × maxSize while preserving aspect ratio.
 * Emits a JPEG data URL — small enough for SQLite, universally supported on receipts.
 */
async function resizeImage(file: File, maxSize: number, quality: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas context');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
}
