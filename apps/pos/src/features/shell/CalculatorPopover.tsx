import { useCallback, useEffect, useState } from 'react';
import { Button, cn } from '@cheeseoclock/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { Calculator as CalcIcon, X, Eraser, Delete } from 'lucide-react';

/**
 * Calculator popover — always available from the TopBar.
 * Plain arithmetic + change calculator for cashiers.
 *
 * Keyboard: digits, +, -, asterisk, slash, ., Enter (=), Backspace, Esc.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

type Op = '+' | '−' | '×' | '÷';

export function CalculatorPopover({ open, onClose }: Props) {
  const [display, setDisplay] = useState('0');
  const [accum, setAccum] = useState<number | null>(null);
  const [pendingOp, setPendingOp] = useState<Op | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const apply = useCallback(
    (a: number, b: number, op: Op): number => {
      switch (op) {
        case '+':
          return a + b;
        case '−':
          return a - b;
        case '×':
          return a * b;
        case '÷':
          return b === 0 ? NaN : a / b;
      }
    },
    [],
  );

  const inputDigit = useCallback(
    (d: string) => {
      if (overwrite) {
        setDisplay(d === '.' ? '0.' : d);
        setOverwrite(false);
        return;
      }
      if (d === '.' && display.includes('.')) return;
      setDisplay(display === '0' && d !== '.' ? d : display + d);
    },
    [display, overwrite],
  );

  const setOp = useCallback(
    (op: Op) => {
      const val = parseFloat(display);
      if (accum === null) {
        setAccum(val);
      } else if (pendingOp) {
        const next = apply(accum, val, pendingOp);
        setAccum(next);
        setDisplay(formatNum(next));
      }
      setPendingOp(op);
      setOverwrite(true);
    },
    [accum, pendingOp, display, apply],
  );

  const equals = useCallback(() => {
    if (pendingOp == null || accum == null) return;
    const val = parseFloat(display);
    const result = apply(accum, val, pendingOp);
    const expr = `${formatNum(accum)} ${pendingOp} ${formatNum(val)} = ${formatNum(result)}`;
    setHistory((h) => [expr, ...h].slice(0, 6));
    setDisplay(formatNum(result));
    setAccum(null);
    setPendingOp(null);
    setOverwrite(true);
  }, [accum, pendingOp, display, apply]);

  const clear = useCallback(() => {
    setDisplay('0');
    setAccum(null);
    setPendingOp(null);
    setOverwrite(false);
  }, []);

  const backspace = useCallback(() => {
    if (overwrite) return;
    setDisplay((d) => (d.length <= 1 || (d.length === 2 && d.startsWith('-')) ? '0' : d.slice(0, -1)));
  }, [overwrite]);

  // Keyboard support
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const k = e.key;
      if (/^[0-9]$/.test(k)) {
        inputDigit(k);
      } else if (k === '.') {
        inputDigit('.');
      } else if (k === '+') {
        setOp('+');
      } else if (k === '-') {
        setOp('−');
      } else if (k === '*') {
        setOp('×');
      } else if (k === '/') {
        e.preventDefault();
        setOp('÷');
      } else if (k === 'Enter' || k === '=') {
        equals();
      } else if (k === 'Backspace') {
        backspace();
      } else if (k === 'Escape') {
        onClose();
      } else if (k.toLowerCase() === 'c') {
        clear();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, inputDigit, setOp, equals, backspace, clear, onClose]);

  const keys: Array<{ label: string; onClick: () => void; tone?: string }> = [
    { label: 'C', onClick: clear, tone: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200' },
    { label: '⌫', onClick: backspace, tone: 'bg-stone-200 text-stone-700 dark:bg-stone-700' },
    { label: '%', onClick: () => setDisplay(formatNum(parseFloat(display) / 100)), tone: 'bg-stone-200 text-stone-700 dark:bg-stone-700' },
    { label: '÷', onClick: () => setOp('÷'), tone: 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100' },
    { label: '7', onClick: () => inputDigit('7') },
    { label: '8', onClick: () => inputDigit('8') },
    { label: '9', onClick: () => inputDigit('9') },
    { label: '×', onClick: () => setOp('×'), tone: 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100' },
    { label: '4', onClick: () => inputDigit('4') },
    { label: '5', onClick: () => inputDigit('5') },
    { label: '6', onClick: () => inputDigit('6') },
    { label: '−', onClick: () => setOp('−'), tone: 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100' },
    { label: '1', onClick: () => inputDigit('1') },
    { label: '2', onClick: () => inputDigit('2') },
    { label: '3', onClick: () => inputDigit('3') },
    { label: '+', onClick: () => setOp('+'), tone: 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100' },
    { label: '0', onClick: () => inputDigit('0') },
    { label: '.', onClick: () => inputDigit('.') },
    { label: '00', onClick: () => { inputDigit('0'); inputDigit('0'); } },
    {
      label: '=',
      onClick: equals,
      tone: 'bg-emerald-500 text-white shadow-soft-sm hover:bg-emerald-600',
    },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-3 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
              <CalcIcon className="h-4 w-4" />
              Calculator
              <kbd className="rounded bg-stone-200 px-1 text-[10px] font-mono dark:bg-stone-700">Esc</kbd>
            </Dialog.Title>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="rounded-xl bg-stone-100 p-3 text-right dark:bg-stone-800">
            {pendingOp && accum !== null && (
              <div className="font-mono text-xs text-stone-500">
                {formatNum(accum)} {pendingOp}
              </div>
            )}
            <div className="overflow-hidden text-ellipsis font-mono text-3xl font-bold tracking-tight">
              {display}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {keys.map((k) => (
              <button
                key={k.label}
                type="button"
                onClick={k.onClick}
                className={cn(
                  'h-12 rounded-lg font-semibold text-stone-800 transition-colors hover:brightness-95 active:scale-95 dark:text-stone-100',
                  k.tone ?? 'bg-stone-50 hover:bg-stone-100 dark:bg-stone-800 dark:hover:bg-stone-700',
                )}
              >
                {k.label}
              </button>
            ))}
          </div>

          {history.length > 0 && (
            <div className="mt-3 rounded-lg bg-stone-50 p-2 text-xs dark:bg-stone-800">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-semibold uppercase tracking-wider text-stone-500">
                  Recent
                </span>
                <button
                  onClick={() => setHistory([])}
                  className="flex items-center gap-1 text-[10px] text-stone-400 hover:text-stone-600"
                >
                  <Eraser className="h-3 w-3" /> Clear
                </button>
              </div>
              <ul className="space-y-0.5 font-mono text-stone-600 dark:text-stone-400">
                {history.map((h, i) => (
                  <li key={i} className="truncate">
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return 'Error';
  // Avoid 1e-7 sci-notation noise for typical retail math.
  return Math.round(n * 1e6) / 1e6 + '';
}
