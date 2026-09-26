import { useRef, useState } from 'react';
import { Button } from '@cheeseoclock/ui';
import { ImageUp, Trash2 } from 'lucide-react';
import { LOGO_ACCEPT, prepareLogo } from './logoImage';

/**
 * Pick the shop's logo. The preview shows the whole picture on a
 * checkerboard (so a transparent background is visible as such) and never
 * crops it, the same way it is shown everywhere else in the till.
 */
export function LogoPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await prepareLogo(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label={value ? 'Change the logo' : 'Upload a logo'}
        className="flex h-28 w-48 items-center justify-center overflow-hidden rounded-xl p-3 ring-1 ring-stone-300 transition-shadow hover:ring-2 hover:ring-amber-400 dark:ring-stone-600"
        style={{
          // Checkerboard: shows which parts of the logo are see-through.
          backgroundColor: '#fff',
          backgroundImage:
            'linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
        }}
      >
        {busy ? (
          <span className="text-xs font-medium text-stone-500">Preparing…</span>
        ) : value ? (
          <img src={value} alt="Current logo" className="h-full w-full object-contain" draggable={false} />
        ) : (
          <span className="flex flex-col items-center gap-1 text-xs font-medium text-stone-500">
            <ImageUp className="h-6 w-6" />
            No logo yet
          </span>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            <ImageUp className="h-4 w-4" />
            {value ? 'Change logo' : 'Upload logo'}
          </Button>
          {value && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange(null)}>
              <Trash2 className="h-4 w-4" />
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-stone-500">
          PNG with a see-through background looks best; JPG and SVG work too. Any shape is fine —
          the whole logo is always shown, never cut off.
        </p>
        {error && (
          <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={LOGO_ACCEPT}
        className="hidden"
        onChange={(e) => void onFile(e)}
      />
    </div>
  );
}
