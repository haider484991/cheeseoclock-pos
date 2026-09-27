import { useState, type ReactNode } from 'react';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { AlertTriangle, ChevronDown, ChevronRight, CloudOff, History, Lock, RotateCcw } from 'lucide-react';
import type { ShopSettingCard, ShopSettingKey, ShopSettingValues } from '@cheeseoclock/shared-types';
import { askConfirm } from '../../../components/confirm/ConfirmHost';

/** "27 Sep, 14:02" */
export function whenSaved(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "Last changed by Owner on the other till, 27 Sep, 14:02" — or that it never was. */
export function lastChangedText(card: Pick<ShopSettingCard, 'lastChanged'>): string {
  const c = card.lastChanged;
  if (!c) return 'Never changed: the till works as it always has.';
  const where = c.onThisTill === true ? ' on this till' : c.onThisTill === false ? ' on the other till' : '';
  return `Last changed by ${c.byName ?? 'someone'}${where}, ${whenSaved(c.at)}`;
}

interface Props<K extends ShopSettingKey> {
  card: ShopSettingCard<K>;
  title: string;
  icon: ReactNode;
  intro: ReactNode;
  /** One line per value, for History. */
  describe: (value: ShopSettingValues[K]) => string;
  /** The form differs from what is saved. */
  dirty: boolean;
  /** Why the form can't be saved yet, in plain words; null when it can. */
  problem: string | null;
  busy: boolean;
  onSave: () => void;
  onPutBack: () => void;
  /** The fields. */
  children: ReactNode;
  /** Under the fields: the worked example. */
  footer?: ReactNode;
}

/**
 * The owner's settings card, the same for every shop rule: the fields, Save,
 * "Put back the default" (asked in the app's own dialog, and it WRITES the
 * default's values), who changed it last and on which till, whether the
 * other till has it yet, and its History. Read-only when a newer version of
 * the app saved it.
 */
export function SettingCard<K extends ShopSettingKey>(p: Props<K>) {
  const [showHistory, setShowHistory] = useState(false);
  const { card } = p;
  const locked = card.readOnly;

  async function putBack() {
    const ok = await askConfirm(
      `Put back the default for “${p.title}”?\nIt becomes: ${p.describe(card.defaultValue)}. Both tills get it; orders already open keep what they have.`,
    );
    if (ok) p.onPutBack();
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {p.icon} {p.title}
            {card.isDefault && (
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                Default
              </span>
            )}
          </h2>
          <div className="mt-0.5 text-sm text-stone-500">{p.intro}</div>
        </div>
      </div>

      {locked && (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <Lock className="h-4 w-4 shrink-0" />
          Saved by a newer version of the app — update this till to change it. This till uses what it understands of it.
        </p>
      )}

      <fieldset disabled={locked || p.busy} className="space-y-4">
        {p.children}
      </fieldset>

      {p.footer}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3 dark:border-stone-700">
        <Button onClick={p.onSave} disabled={locked || p.busy || !p.dirty || p.problem !== null}>
          {p.busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="secondary" onClick={() => void putBack()} disabled={locked || p.busy || card.isDefault}>
          <RotateCcw className="mr-1 h-4 w-4" /> Put back the default
        </Button>
        {p.dirty && p.problem && (
          <span className="flex items-center gap-1 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" /> {p.problem}
          </span>
        )}
        {p.dirty && !p.problem && <span className="text-sm text-stone-500">Not saved yet.</span>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
        <span>{lastChangedText(card)}</span>
        {card.notOnOtherTillYet && (
          <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-300">
            <CloudOff className="h-3.5 w-3.5" /> Not on the other till yet
          </span>
        )}
        {card.history.length > 0 && (
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="inline-flex items-center gap-1 font-medium text-stone-600 hover:text-stone-900 dark:text-stone-300"
            aria-expanded={showHistory}
          >
            {showHistory ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <History className="h-3.5 w-3.5" /> History
          </button>
        )}
      </div>
      {showHistory && (
        <ol className="mt-2 space-y-1 rounded-lg bg-stone-50 p-3 text-xs dark:bg-stone-800/60">
          {card.history.map((h, i) => (
            <li key={`${h.at}-${i}`} className={cn('flex flex-wrap gap-x-2', i === 0 && 'font-medium')}>
              <span className="font-mono text-stone-500">{whenSaved(h.at)}</span>
              <span>
                {h.byName ?? 'Someone'} {h.onThisTill ? 'on this till' : 'on the other till'}:
              </span>
              <span className="text-stone-700 dark:text-stone-200">{h.value ? p.describe(h.value) : 'a value this version can’t read'}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
