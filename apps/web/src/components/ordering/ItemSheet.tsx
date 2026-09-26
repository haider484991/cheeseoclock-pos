'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isLeaveOutChoice,
  type PublishedMenuItem,
  type PublishedModifierGroup,
} from '@cheeseoclock/shared-types';
import { MAX_NOTE_LENGTH } from '@/lib/cart';
import { formatCents } from '@/lib/format';
import { groupLabel, optionLabel, requiredCount, sizeLabel, type MenuCard, type MenuVariant } from '@/lib/menu-view';
import { sheetOptionLabel } from '@/lib/order-display';
import { Stepper } from './cart-ui';
import { CloseButton, Sheet } from './Sheet';

/** What the Add button asks for while choices are missing: "Pick 3 more", "Choose your dip". */
function unmetText(group: PublishedModifierGroup, selected: Set<string>): string {
  const need = requiredCount(group);
  const chosen = group.modifiers.filter((m) => selected.has(m.posModifierId)).length;
  if (need > 1) return `Pick ${need - chosen} more`;
  const label = groupLabel(group);
  return /^choose\b/i.test(label) ? label : `Choose ${label.toLowerCase()}`;
}

function defaultsOf(it: PublishedMenuItem): Set<string> {
  return new Set(
    it.modifierGroups.flatMap((g) => g.modifiers.filter((m) => m.isDefault).map((m) => m.posModifierId)),
  );
}

function isUnmet(g: PublishedModifierGroup, sel: Set<string>): boolean {
  return g.modifiers.filter((m) => sel.has(m.posModifierId)).length < requiredCount(g);
}

/** Size, choices (required first as the till orders them), a kitchen note, quantity → Add. */
export function ItemSheet({
  card,
  initialVariant,
  onClose,
  onConfirm,
}: {
  card: MenuCard;
  initialVariant: number;
  onClose: () => void;
  onConfirm: (variant: MenuVariant, modifierIds: string[], quantity: number, notes: string | null) => void;
}) {
  const [variantIndex, setVariantIndex] = useState(initialVariant);
  const [notes, setNotes] = useState('');
  const variant = card.variants[variantIndex] ?? card.variants[0]!;
  const item = variant.item;
  const groups = useMemo(() => item.modifierGroups.slice().sort((a, b) => a.sortOrder - b.sortOrder), [item]);
  const [qty, setQty] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(() => defaultsOf(item));

  // Another size is another till item with its own modifier ids. Carry the
  // choices across by name (Medium and Large share their groups' options),
  // falling back to that item's defaults.
  function switchVariant(i: number) {
    const next = card.variants[i];
    if (!next) return;
    const keyOf = (g: PublishedModifierGroup, optionName: string) => `${groupLabel(g)}|${optionLabel(optionName)}`;
    const chosenNames = new Set(
      item.modifierGroups.flatMap((g) =>
        g.modifiers.filter((m) => selected.has(m.posModifierId)).map((m) => keyOf(g, m.name)),
      ),
    );
    const carried = new Set<string>();
    for (const g of next.item.modifierGroups) {
      for (const m of g.modifiers) {
        if (chosenNames.has(keyOf(g, m.name))) carried.add(m.posModifierId);
      }
    }
    setVariantIndex(i);
    setSelected(carried.size > 0 ? carried : defaultsOf(next.item));
  }

  // A deal has two pizza slots, and on a phone the second sits below the fold:
  // customers picked one pizza, met a grey "Choose 2nd large pizza" button that
  // did nothing, and took it for the deal not adding (owner, 2026-09-25). So a
  // finished single choice scrolls on to the next open group, and the Add
  // button, while choices are missing, takes you to the first one and flags it.
  const groupRefs = useRef(new Map<string, HTMLFieldSetElement>());
  const [flagged, setFlagged] = useState<string | null>(null);
  const flagTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flagTimer.current) clearTimeout(flagTimer.current);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  function showGroup(groupId: string, flag: boolean) {
    groupRefs.current.get(groupId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!flag) return;
    setFlagged(groupId);
    if (flagTimer.current) clearTimeout(flagTimer.current);
    flagTimer.current = setTimeout(() => setFlagged(null), 1400);
  }

  function toggle(group: PublishedModifierGroup, modId: string) {
    const next = new Set(selected);
    if (group.selectionType === 'single') {
      // Radio behaviour: clear siblings.
      for (const m of group.modifiers) next.delete(m.posModifierId);
      next.add(modId);
    } else if (next.has(modId)) {
      next.delete(modId);
    } else {
      const chosen = group.modifiers.filter((m) => next.has(m.posModifierId)).length;
      if (group.maxSelect > 0 && chosen >= group.maxSelect) return;
      next.add(modId);
    }
    setSelected(next);
    if (group.selectionType === 'single') {
      const after = groups.slice(groups.indexOf(group) + 1).find((g) => isUnmet(g, next));
      if (after) {
        if (scrollTimer.current) clearTimeout(scrollTimer.current);
        scrollTimer.current = setTimeout(() => showGroup(after.posGroupId, false), 160);
      }
    }
  }

  const unmet = groups.filter((g) => isUnmet(g, selected));
  const extra = groups
    .flatMap((g) => g.modifiers)
    .filter((m) => selected.has(m.posModifierId))
    .reduce((s, m) => s + m.priceDeltaCents, 0);
  const unit = item.basePriceCents + extra;
  const notesLeft = MAX_NOTE_LENGTH - notes.length;

  return (
    <Sheet onClose={onClose} label={card.name}>
      <div className="relative shrink-0 bg-ink px-5 pb-5 pt-5 text-cream">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-3xl uppercase leading-none tracking-wide">{card.name}</h3>
            {card.description && <p className="mt-2 text-sm leading-snug text-cream/75">{card.description}</p>}
          </div>
          {card.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.image}
              alt=""
              width={96}
              height={96}
              className="-my-2 h-24 w-24 shrink-0 object-contain drop-shadow-[0_10px_16px_rgba(0,0,0,0.5)]"
            />
          ) : null}
          <CloseButton onClose={onClose} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
        {card.variants.length > 1 && (
          <fieldset className="mt-5">
            <legend className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">Size</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {card.variants.map((v, i) => (
                <button
                  type="button"
                  key={v.item.posItemId}
                  onClick={() => switchVariant(i)}
                  aria-pressed={i === variantIndex}
                  className={`rounded-2xl border-2 px-3 py-2.5 text-left transition-colors ${
                    i === variantIndex
                      ? 'border-ink bg-ink text-cheese'
                      : 'border-paper-line bg-white text-ink hover:border-ink/40'
                  }`}
                >
                  <span className="block font-cond text-base font-extrabold uppercase">{sizeLabel(v.size)}</span>
                  <span className="font-cond text-sm font-bold tabular-nums opacity-80">
                    {formatCents(v.item.basePriceCents)}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {groups.map((g) => {
          const chosen = g.modifiers.filter((m) => selected.has(m.posModifierId)).length;
          const need = requiredCount(g);
          const full = g.maxSelect > 0 && chosen >= g.maxSelect;
          const done = chosen >= need;
          // Long lists (a deal's 8 pizzas, the dips, the extras) go two-up on a
          // phone too, so a deal's two pizza slots fit on one screen and the
          // optional groups don't bury the Add button under a long scroll.
          const twoUp = g.modifiers.length >= 6;
          return (
            <fieldset
              key={g.posGroupId}
              ref={(el) => {
                if (el) groupRefs.current.set(g.posGroupId, el);
                else groupRefs.current.delete(g.posGroupId);
              }}
              className={`mt-5 scroll-mt-3 rounded-2xl transition-shadow duration-300 ${
                flagged === g.posGroupId ? 'animate-pulse ring-4 ring-cheese ring-offset-4 ring-offset-paper' : ''
              }`}
            >
              <legend className="flex w-full items-center justify-between gap-2">
                <span className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
                  {groupLabel(g)}
                </span>
                {need === 0 ? (
                  <span className="font-cond text-xs font-bold uppercase tracking-wide text-ink-muted">
                    Optional{chosen > 0 ? ` · ${chosen} chosen` : ''}
                  </span>
                ) : g.selectionType === 'multi' && g.maxSelect > 1 ? (
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-cond text-xs font-bold uppercase ${
                      done ? 'bg-emerald-600 text-white' : 'bg-cheese text-ink'
                    }`}
                  >
                    {chosen}/{g.maxSelect} chosen
                  </span>
                ) : (
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-cond text-xs font-bold uppercase ${
                      done ? 'bg-emerald-600 text-white' : 'bg-cheese text-ink'
                    }`}
                  >
                    {done ? '✓ chosen' : 'Required'}
                  </span>
                )}
              </legend>
              <div className={`mt-2 grid gap-1.5 ${twoUp ? 'grid-cols-2' : 'sm:grid-cols-2'}`}>
                {g.modifiers
                  .slice()
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((m) => {
                    const checked = selected.has(m.posModifierId);
                    const blocked = !checked && full && g.selectionType === 'multi';
                    return (
                      <label
                        key={m.posModifierId}
                        className={`flex min-h-[2.75rem] cursor-pointer items-center justify-between gap-2 rounded-xl border-2 px-2.5 py-2 text-sm transition-colors ${
                          checked && isLeaveOutChoice(m.name)
                            ? 'border-red-600 bg-red-50'
                            : checked
                              ? 'border-ink bg-cheese/25'
                              : blocked
                                ? 'cursor-not-allowed border-paper-line bg-white opacity-45'
                                : 'border-paper-line bg-white hover:border-ink/40'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type={g.selectionType === 'single' ? 'radio' : 'checkbox'}
                            name={g.posGroupId}
                            checked={checked}
                            disabled={blocked}
                            onChange={() => toggle(g, m.posModifierId)}
                            className="h-4 w-4 shrink-0 accent-ink"
                          />
                          <span className="font-semibold leading-tight text-ink">{sheetOptionLabel(m.name)}</span>
                        </span>
                        {m.priceDeltaCents !== 0 && (
                          <span className="shrink-0 font-cond text-xs font-bold tabular-nums text-ink-muted">
                            +{formatCents(m.priceDeltaCents)}
                          </span>
                        )}
                      </label>
                    );
                  })}
              </div>
            </fieldset>
          );
        })}

        <label className="mt-5 block">
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
              Allergy or special request
            </span>
            <span className="font-cond text-xs font-bold uppercase tracking-wide text-ink-muted">Optional</span>
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, MAX_NOTE_LENGTH))}
            rows={2}
            maxLength={MAX_NOTE_LENGTH}
            placeholder="e.g. tell us about an allergy, well done, cut in 8"
            className="mt-2 w-full rounded-xl border-2 border-paper-line bg-white px-3 py-2.5 text-base text-ink placeholder:text-ink-muted/70 focus:border-ink focus:outline-none"
          />
          <span className="mt-1 flex justify-between gap-3 text-xs leading-snug text-ink-muted">
            <span>
              Goes to the kitchen with this item. Our kitchen shares equipment, so we can&rsquo;t guarantee any dish
              is allergen-free.
            </span>
            {notesLeft < 60 && <span className="shrink-0 tabular-nums">{notesLeft} left</span>}
          </span>
        </label>
      </div>

      <div className="pb-safe-4 flex shrink-0 items-center gap-3 border-t border-paper-line bg-white px-5 pt-4">
        <Stepper value={qty} onChange={setQty} label={card.name} min={1} large />
        <button
          type="button"
          aria-disabled={unmet.length > 0}
          onClick={() =>
            unmet.length > 0
              ? showGroup(unmet[0]!.posGroupId, true)
              : onConfirm(variant, [...selected], qty, notes.trim() || null)
          }
          className={`min-h-[3.25rem] flex-1 rounded-full bg-ink px-3 py-3 font-cond text-lg font-bold uppercase tracking-wide text-cheese transition-all active:scale-[0.99] ${
            unmet.length > 0 ? 'opacity-55' : 'hover:bg-ink-soft'
          }`}
        >
          {unmet.length > 0
            ? unmetText(unmet[0]!, selected)
            : `Add${qty > 1 ? ` ${qty}` : ''} · ${formatCents(unit * qty)}`}
        </button>
      </div>
    </Sheet>
  );
}
