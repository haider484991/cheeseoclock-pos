/**
 * Settings → Kitchen & stock (owner, 2026-09-27: "everything should be
 * editable for admin… as a developer I should not change anything every
 * time from code").
 *
 * Two cards, each its own synced setting:
 *  - the stock rules ('stock.rules'): when "used vs should have used" goes
 *    on the Dashboard's "Do this" and how it is rated (pos-domain
 *    varianceBand / varianceDoThisRules: the Dashboard, the weekly sheet and
 *    Reports → Between stock takes all use them), the stock-take reminders,
 *    the stock bar's and "Add low-stock items"' multiple of the low level,
 *    and the Waste screen's reasons — fixed ids, so a rename follows every
 *    old waste row; a saved reason can be hidden, not removed (either till
 *    may have waste entries with it; the main process refuses that), and
 *    one added since the last Save can still come off;
 *  - what a menu file import may change on what the till already has
 *    ('menu.importPolicy'); the import preview lists what was "kept on the
 *    till".
 *  - below it, the menu files from the costing PC (v0.7.32,
 *    MenuFromCostingPc.tsx): put in by themselves or wait for the owner's
 *    OK ('menu.autoUpdate'), and the upload key — each loading on its own.
 * The default food-cost target is on Costing → Targets, where the other
 * targets are. The owner alone (the main process refuses anyone else); the
 * defaults are exactly what the till did before.
 */
import { useMemo, useState } from 'react';
import { Button, cn } from '@cheeseoclock/ui';
import { Boxes, Eye, EyeOff, FileInput, Plus, Trash2 } from 'lucide-react';
import { releasedWasteReasonLabel } from '@cheeseoclock/pos-domain';
import {
  STOCK_RULE_BOUNDS,
  WASTE_REASON_LABEL_MAX,
  type ImportSide,
  type MenuImportPolicy,
  type ShopSettingCard,
  type StockRules,
} from '@cheeseoclock/shared-types';
import { SettingCard } from './shop-rules/SettingCard';
import { MenuFromCostingPc } from './MenuFromCostingPc';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting, useShopSettingsLive } from './shop-rules/useShopSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  addWasteReason,
  canRemoveWasteReason,
  removeWasteReason,
  renameWasteReason,
  sameStockRules,
  setWasteReasonHidden,
  stockRulesFromForm,
  stockRulesToForm,
  type StockRulesForm,
} from './shop-rules/stockRulesForm';
import {
  IMPORT_POLICY_FIELDS,
  importPolicyExample,
  importPolicySummary,
  remindersText,
  reorderExample,
  stockRulesSummary,
  varianceExample,
} from './shop-rules/stockRulesWords';

const inputClass =
  'w-20 rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const sectionTitle = 'text-sm font-semibold';
const helpClass = 'mt-1 text-xs text-stone-500';
const exampleClass = 'mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100';

export function KitchenStockSettings() {
  useShopSettingsLive();
  const stockS = useShopSetting('stock.rules');
  const importS = useShopSetting('menu.importPolicy');

  if (stockS.q.isError || importS.q.isError) {
    return <p className="py-6 text-center text-stone-500">Could not load Kitchen &amp; stock.</p>;
  }
  if (!stockS.q.data || !importS.q.data) {
    return <p className="py-6 text-center text-stone-500">Loading…</p>;
  }
  return <KitchenStockCards stock={stockS} importPolicy={importS} />;
}

/** A number box with its words either side ("Good under [2] % of food sales"). */
function Inline({
  id,
  before,
  value,
  onChange,
  after,
  disabled,
  decimals,
}: {
  id: string;
  before: string;
  value: string;
  onChange: (v: string) => void;
  after: string;
  disabled?: boolean;
  decimals?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm">
      <span>{before}</span>
      <input
        id={id}
        inputMode={decimals ? 'decimal' : 'numeric'}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange((decimals ? e.target.value.replace(/[^\d.]/g, '') : e.target.value.replace(/[^\d]/g, '')).slice(0, 4))}
        className={inputClass}
      />
      <span className="text-stone-600 dark:text-stone-300">{after}</span>
    </label>
  );
}

function KitchenStockCards({
  stock,
  importPolicy,
}: {
  stock: ReturnType<typeof useShopSetting<'stock.rules'>>;
  importPolicy: ReturnType<typeof useShopSetting<'menu.importPolicy'>>;
}) {
  const stockCard = stock.q.data as ShopSettingCard<'stock.rules'>;
  const importCard = importPolicy.q.data as ShopSettingCard<'menu.importPolicy'>;

  const stockD = useDraft<StockRules, StockRulesForm>(stockCard.value, stockRulesToForm);
  const stockParsed = useMemo(() => stockRulesFromForm(stockD.form), [stockD.form]);
  const stockDirty = stockD.touched && (stockParsed.value === null || !sameStockRules(stockParsed.value, stockCard.value));
  // The examples follow what is typed as soon as it reads; the saved value until then.
  const shown = stockParsed.value ?? stockCard.value;
  const set = (patch: Partial<StockRulesForm>) => stockD.set({ ...stockD.form, ...patch });
  const [newReason, setNewReason] = useState('');

  const importD = useDraft<MenuImportPolicy, MenuImportPolicy>(importCard.value, (v) => ({ ...v }));
  const importDirty = importD.touched && !sameValue(importD.form, importCard.value);

  const [bLo, bHi] = STOCK_RULE_BOUNDS.bandBps;
  const f = stockD.form;

  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Stock takes, the stock bar, waste and menu files. Both tills use them as soon as they are linked. The default food-cost target for
        a new menu category is on Costing → Targets.
      </p>

      <SettingCard
        card={stockCard}
        title="Stock takes and waste"
        icon={<Boxes className="h-5 w-5" />}
        intro="When “used vs should have used” goes on the Dashboard and how it is rated (the Dashboard, the weekly sheet and Reports → Between stock takes), reminders to take stock, how full a stock bar is, and the reasons on the Waste screen. Put back the default keeps the reasons you added, hidden: waste entries on either till may use them."
        describe={stockRulesSummary}
        dirty={stockDirty}
        problem={stockParsed.problem}
        busy={stock.save.isPending || stock.putBack.isPending}
        onSave={() => stockParsed.value && stock.save.mutate(stockParsed.value, { onSuccess: stockD.reset })}
        onPutBack={() => stock.putBack.mutate(undefined, { onSuccess: stockD.reset })}
      >
        <section>
          <h3 className={sectionTitle}>Used vs should have used</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <Inline id="stock-dothis" before="On “Do this” when over" value={f.doThis} onChange={(v) => set({ doThis: v })} after="% of food sales" decimals />
            <Inline
              id="stock-window"
              before="…and the stock takes are at least"
              value={f.minWindowDays}
              onChange={(v) => set({ minWindowDays: v })}
              after={`days apart (${STOCK_RULE_BOUNDS.varianceMinWindowDays[0]} to ${STOCK_RULE_BOUNDS.varianceMinWindowDays[1]})`}
            />
            <Inline id="stock-good" before="Good under" value={f.good} onChange={(v) => set({ good: v })} after="%" decimals />
            <Inline id="stock-ok" before="OK up to" value={f.ok} onChange={(v) => set({ ok: v })} after="%" decimals />
            <Inline
              id="stock-needswork"
              before="Needs work up to"
              value={f.needsWork}
              onChange={(v) => set({ needsWork: v })}
              after="%; above it: Look at it now"
              decimals
            />
          </div>
          <p className={helpClass}>
            Shares of the food sales between two stock takes, {bLo / 100}% to {bHi / 100}%, at most one decimal. Either way counts: more on the
            shelves than the till expected is a sign too.
          </p>
          <p className={exampleClass} aria-live="polite">
            <span className="font-semibold">For example: </span>
            {varianceExample(shown)}
          </p>
        </section>

        <section>
          <h3 className={sectionTitle}>Stock-take reminders</h3>
          <div className="mt-2 space-y-2">
            {(
              [
                {
                  on: 'keyItemsOn',
                  days: 'keyItemsDays',
                  label: 'Remind me to count the key items every',
                  daysName: 'Days between key-items counts',
                  bounds: STOCK_RULE_BOUNDS.keyItemsEveryDays,
                },
                {
                  on: 'fullOn',
                  days: 'fullDays',
                  label: 'Remind me to do a full stock take every',
                  daysName: 'Days between full stock takes',
                  bounds: STOCK_RULE_BOUNDS.fullEveryDays,
                },
              ] as const
            ).map((r) => (
              <div key={r.on} className="flex flex-wrap items-center gap-2 text-sm">
                {/* The words tick the box; the days box has its own name. */}
                <label htmlFor={`stock-${r.on}`} className="flex items-center gap-2">
                  <input
                    id={`stock-${r.on}`}
                    type="checkbox"
                    checked={f[r.on]}
                    onChange={(e) => set({ [r.on]: e.target.checked } as Partial<StockRulesForm>)}
                  />
                  <span>{r.label}</span>
                </label>
                <input
                  id={`stock-${r.days}`}
                  aria-label={r.daysName}
                  inputMode="numeric"
                  value={f[r.days]}
                  disabled={!f[r.on]}
                  onChange={(e) => set({ [r.days]: e.target.value.replace(/[^\d]/g, '').slice(0, 4) } as Partial<StockRulesForm>)}
                  className={inputClass}
                />
                <span className="text-stone-600 dark:text-stone-300">{`days (${r.bounds[0]} to ${r.bounds[1]})`}</span>
              </div>
            ))}
          </div>
          <p className={helpClass}>{remindersText(shown.reminders)}</p>
        </section>

        <section>
          <h3 className={sectionTitle}>Stock bar and purchase orders</h3>
          <div className="mt-2">
            <Inline
              id="stock-multiple"
              before="A full stock bar is"
              value={f.reorderMultiple}
              onChange={(v) => set({ reorderMultiple: v })}
              after={`times the low level (${STOCK_RULE_BOUNDS.reorderMultiple[0]} to ${STOCK_RULE_BOUNDS.reorderMultiple[1]})`}
            />
          </div>
          <p className={exampleClass} aria-live="polite">
            <span className="font-semibold">For example: </span>
            {reorderExample(shown.reorderMultiple)}
          </p>
        </section>

        <section>
          <h3 className={sectionTitle}>Waste reasons</h3>
          <p className={helpClass}>
            What the Waste screen asks, in this order, and how Reports split waste. Every waste entry keeps its reason, not the name: a new
            name shows on the old entries too. Hide a reason to take it off the Waste screen. A reason you add can be removed until you save
            it; once saved, waste entries on either till may use it, so it can only be hidden or renamed. The till’s own seven can be renamed
            or hidden, never removed.
          </p>
          <ul className="mt-2 space-y-2">
            {f.reasons.map((r) => {
              const released = releasedWasteReasonLabel(r.id);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={`Name of the waste reason ${released ?? r.label}`}
                    value={r.label}
                    maxLength={WASTE_REASON_LABEL_MAX}
                    onChange={(e) => set({ reasons: renameWasteReason(f.reasons, r.id, e.target.value) })}
                    className={cn(
                      'w-64 rounded-lg border border-stone-300 px-3 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800',
                      r.hidden && 'text-stone-400 line-through',
                    )}
                  />
                  <Button variant="secondary" size="sm" onClick={() => set({ reasons: setWasteReasonHidden(f.reasons, r.id, !r.hidden) })}>
                    {r.hidden ? <Eye className="mr-1 h-4 w-4" /> : <EyeOff className="mr-1 h-4 w-4" />}
                    {r.hidden ? 'Show again' : 'Hide'}
                  </Button>
                  {canRemoveWasteReason(r.id, stockCard.value.wasteReasons) && (
                    <Button variant="secondary" size="sm" onClick={() => set({ reasons: removeWasteReason(f.reasons, r.id) })}>
                      <Trash2 className="mr-1 h-4 w-4" /> Remove
                    </Button>
                  )}
                  {r.hidden && <span className="text-xs text-stone-500">hidden: off the Waste screen, still named in Reports</span>}
                  {released !== null && released !== r.label.trim() && <span className="text-xs text-stone-500">was “{released}”</span>}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              aria-label="A new waste reason"
              placeholder="A new reason, e.g. Spilled"
              value={newReason}
              maxLength={WASTE_REASON_LABEL_MAX}
              onChange={(e) => setNewReason(e.target.value)}
              className="w-64 rounded-lg border border-stone-300 px-3 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={newReason.trim() === ''}
              onClick={() => {
                set({ reasons: addWasteReason(f.reasons, newReason) });
                setNewReason('');
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> Add reason
            </Button>
          </div>
        </section>
      </SettingCard>

      <SettingCard
        card={importCard}
        title="What a menu file may change"
        icon={<FileInput className="h-5 w-5" />}
        intro="Menu → Import, on what the till already has. New items, choices, ingredients and recipes always come in; nothing is deleted, renamed or moved; stock is never changed; ingredient prices stay the till’s (the sheet only prices a new ingredient or one with none); where each item and category sells on the website (Menu → On the website) is always kept on the till, so the import preview does not list it. The preview lists everything else kept on the till before anything is saved."
        describe={importPolicySummary}
        dirty={importDirty}
        problem={null}
        busy={importPolicy.save.isPending || importPolicy.putBack.isPending}
        onSave={() => importPolicy.save.mutate(importD.form, { onSuccess: importD.reset })}
        onPutBack={() => importPolicy.putBack.mutate(undefined, { onSuccess: importD.reset })}
        footer={
          <p className={cn(exampleClass, 'mt-4')} aria-live="polite">
            <span className="font-semibold">For example: </span>
            {importPolicyExample(importD.form)}
          </p>
        }
      >
        <ul className="divide-y divide-stone-200 dark:divide-stone-700">
          {IMPORT_POLICY_FIELDS.map((p) => (
            <li key={p.field} className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{p.label}</div>
                <p className="text-xs text-stone-500">{importD.form[p.field] === 'till' ? p.till : p.file}</p>
              </div>
              <div className="flex shrink-0 gap-1" role="radiogroup" aria-label={p.label}>
                {(
                  [
                    ['file', 'The file’s'],
                    ['till', 'Keep the till’s'],
                  ] as Array<[ImportSide, string]>
                ).map(([side, label]) => (
                  <button
                    key={side}
                    type="button"
                    role="radio"
                    aria-checked={importD.form[p.field] === side}
                    onClick={() => importD.set({ ...importD.form, [p.field]: side })}
                    className={cn(
                      'rounded-lg border-2 px-3 py-1.5 text-xs font-semibold transition-colors',
                      importD.form[p.field] === side
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                        : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </SettingCard>

      <MenuFromCostingPc />
    </div>
  );
}
