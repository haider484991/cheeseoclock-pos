import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import { feeForZones, findZone } from '@cheeseoclock/shared-types';
import {
  areaOptionWhere,
  deliveryFeeText,
  formatAreaText,
  rankZones,
  resolveAreaText,
  suggestDeliveryAreas,
  zoneUsageFromAreas,
  type AreaOption,
} from '@cheeseoclock/pos-domain';
import { AlertTriangle, Check, MapPin } from 'lucide-react';
import { ipc } from '../../ipc/client';

/**
 * Deliveries per zone on this till, from the areas saved on customer
 * addresses. Feeds the "most used first" order of the area picker.
 */
export function useAreaUsage(): ReadonlyMap<string, number> | undefined {
  const q = useQuery({
    queryKey: ['customers', 'areaUsage'],
    queryFn: () => ipc.customers.areaUsage(),
    staleTime: 5 * 60_000,
  });
  return useMemo(() => (q.data ? zoneUsageFromAreas(q.data) : undefined), [q.data]);
}

interface AreaPickerProps {
  value: string;
  onChange: (area: string) => void;
  /** 'till' = the checkout panel's inputs; 'form' = a dialog field. */
  variant?: 'till' | 'form';
  /** One-tap chips of the busiest zones while nothing is picked (0 = none). */
  quickPicks?: number;
  autoFocus?: boolean;
  id?: string;
}

/**
 * The delivery area, picked from the one shared list (DHA phases, Clifton
 * blocks, and the commercial areas / landmarks people name instead) — not
 * typed. Typing still works: it searches, and a place that is not on the
 * list is kept but flagged, because the shop delivers in DHA and Clifton only.
 *
 * A place that does not pin one zone (a Khayaban crossing phases, a Clifton
 * landmark) asks "which phase / block?" with one-tap chips, since the zone
 * decides the fee and where the rider goes.
 */
export function AreaPicker({ value, onChange, variant = 'till', quickPicks = 6, autoFocus, id }: AreaPickerProps) {
  const usage = useAreaUsage();
  const listId = useId();
  const [open, setOpen] = useState(false);
  /** What the cashier has typed since focusing; null = browsing the full list. */
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);

  const resolved = useMemo(() => resolveAreaText(value), [value]);
  const suggestions = useMemo(
    () => suggestDeliveryAreas(typed ?? '', { limit: typed ? 12 : 40, usage }),
    [typed, usage],
  );
  const quick = useMemo(() => rankZones(usage).slice(0, quickPicks), [usage, quickPicks]);

  function pick(option: AreaOption, zoneId?: string) {
    onChange(formatAreaText(option, zoneId));
    setOpen(false);
    setTyped(null);
    setActive(0);
    setNavigated(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const n = suggestions.length;
      if (n === 0) return;
      setNavigated(true);
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n));
    } else if (e.key === 'Enter') {
      const option = suggestions[active];
      // Only after typing or arrowing: an Enter on a box the cashier merely
      // tabbed through must not replace the area with the first zone.
      if (open && option && (typed !== null || navigated)) {
        e.preventDefault();
        pick(option);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
    }
  }

  const multi = resolved.option && resolved.zoneIds.length > 1 ? resolved.option : null;
  const pinned = resolved.zoneIds.length === 1 ? findZone(resolved.zoneIds[0]) : undefined;
  const unknown = value.trim() !== '' && resolved.zoneIds.length === 0;
  const activeId = open && suggestions[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="min-w-0">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-label="Delivery area"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        placeholder="Phase / block — tap to pick"
        onFocus={() => {
          setOpen(true);
          setTyped(null);
          setActive(0);
          setNavigated(false);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={
          variant === 'till'
            ? 'cust-input'
            : 'w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800'
        }
      />

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Delivery areas"
          className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-stone-300 bg-white p-1 shadow-md dark:border-stone-700 dark:bg-stone-900"
        >
          {suggestions.length === 0 ? (
            <li className="px-2 py-2 text-xs text-stone-500">
              Not on our list — we deliver in DHA and Clifton only. Clear the box to see every area.
            </li>
          ) : (
            suggestions.map((o, i) => {
              const fee = deliveryFeeText(o.zoneIds);
              return (
                <li key={o.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    tabIndex={-1}
                    // Keep focus in the input so the list does not close before the tap lands.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                    className={cn(
                      'flex min-h-[40px] w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left',
                      i === active ? 'bg-amber-100 dark:bg-stone-800' : 'hover:bg-stone-50 dark:hover:bg-stone-800',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-stone-900 dark:text-stone-100">
                        {o.label}
                      </span>
                      <span className="block truncate text-[11px] text-stone-500">{areaOptionWhere(o)}</span>
                    </span>
                    {fee && (
                      <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                        {fee}
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}

      {!open && multi && (
        <div className="mt-1.5" role="group" aria-label={multi.group === 'DHA' ? 'Which phase?' : 'Which block?'}>
          <div className="mb-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
            {multi.label}: which {multi.group === 'DHA' ? 'phase' : 'block'}?
            {deliveryFeeText(multi.zoneIds) && (
              <span className="ml-1 font-normal text-stone-500">({deliveryFeeText(multi.zoneIds)})</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {multi.zoneIds.map((zid) => {
              const z = findZone(zid);
              if (!z) return null;
              return (
                <button
                  key={zid}
                  type="button"
                  onClick={() => pick(multi, zid)}
                  className="min-h-[32px] rounded-full bg-stone-100 px-2.5 text-xs font-semibold text-stone-800 hover:bg-amber-200 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
                >
                  {z.shortName}
                  {/* Only when the block changes the fee (Clifton 1 & 2). */}
                  {feeForZones(multi.zoneIds) === null && (
                    <span className="ml-1 font-mono font-normal text-stone-500">{deliveryFeeText([zid])}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!open && pinned && (
        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
          <Check className="h-3 w-3" aria-hidden="true" />
          {resolved.option?.kind === 'zone' ? pinned.group : pinned.name} · delivery {deliveryFeeText([pinned.id])}
        </div>
      )}

      {!open && unknown && (
        <div className="mt-1 flex items-start gap-1 text-[11px] text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Not a delivery area on our list (DHA &amp; Clifton only). Tap the box to pick one.</span>
        </div>
      )}

      {!open && !value.trim() && quick.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1" role="group" aria-label="Most used areas">
          <MapPin className="h-3 w-3 text-stone-400" aria-hidden="true" />
          {quick.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => onChange(z.name)}
              className="min-h-[32px] rounded-full bg-stone-100 px-2.5 text-xs font-semibold text-stone-800 hover:bg-amber-200 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
            >
              {z.shortName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
