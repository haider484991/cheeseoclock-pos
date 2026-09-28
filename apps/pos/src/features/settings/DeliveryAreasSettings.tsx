/**
 * Settings → Delivery areas & fees ('delivery.zones'; owner, 28 Sep 2026:
 * "the delvery fee should be editable in settings"). The owner alone (the
 * main process refuses anyone else). Today's 21 areas and fees until the
 * first Save.
 *
 * One card: a table of the areas by group — name, short name (the till's
 * chip), fee in whole rupees, on/off, up/down for the order the till and the
 * website list them in; "Change the fee for several areas"; "Add an area".
 * A rename keeps the old name as a spelling. An area is switched off, never
 * removed. Save (settings:saveDeliveryZones) also makes the
 * "Delivery Charge (Rs N)" items the fees need, in one transaction, and the
 * website gets the areas by themselves with only those items (the bridge's
 * block alone) — never the till's unpublished menu changes.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { ArrowDown, ArrowUp, Bike, Plus } from 'lucide-react';
import { DELIVERY_FEE_MAX_CENTS, type ShopSettingCard } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import {
  CHECKOUT_RULES_KEY,
  SHOP_SETTINGS_KEY,
  useShopSetting,
  useShopSettingsLive,
} from './shop-rules/useShopSetting';
import {
  ZONES_SAVED_TOAST,
  ZONES_SAVE_NOTE,
  moveZoneRow,
  newZoneRow,
  setFeeFor,
  zonesExample,
  zonesFromForm,
  zonesSummary,
  zonesToForm,
  type ZoneRow,
} from './shop-rules/deliveryZonesForm';

const inputClass =
  'w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const labelClass = 'mb-1 block text-xs uppercase tracking-wider text-stone-500';

export function DeliveryAreasSettings() {
  useShopSettingsLive();
  const s = useShopSetting('delivery.zones');
  if (s.q.isError)
    return <p className="py-6 text-center text-stone-500">Could not load the delivery areas.</p>;
  if (!s.q.data) return <p className="py-6 text-center text-stone-500">Loading…</p>;
  return <ZonesCard card={s.q.data as ShopSettingCard<'delivery.zones'>} />;
}

function ZonesCard({ card }: { card: ShopSettingCard<'delivery.zones'> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const draft = useDraft(card.value, zonesToForm);
  const parsed = useMemo(() => zonesFromForm(draft.form), [draft.form]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [bulkFee, setBulkFee] = useState('');
  const [adding, setAdding] = useState({
    name: '',
    shortName: '',
    group: '',
    fee: '',
    aliases: '',
  });
  const rows = draft.form;
  const groups = [...new Set(rows.map((r) => r.group.trim()).filter(Boolean))];
  const dirty = draft.touched && JSON.stringify(rows) !== JSON.stringify(zonesToForm(card.value));

  const done = (what: string, next: ShopSettingCard<'delivery.zones'>) => {
    qc.setQueryData([...SHOP_SETTINGS_KEY, 'delivery.zones'], next);
    void qc.invalidateQueries({ queryKey: SHOP_SETTINGS_KEY });
    void qc.invalidateQueries({ queryKey: CHECKOUT_RULES_KEY });
    void qc.invalidateQueries({ queryKey: ['menu'] });
    toast({
      title: what,
      description: ZONES_SAVED_TOAST,
      variant: 'success',
    });
    draft.reset();
    setTicked(new Set());
  };
  const failed = (e: unknown) =>
    toast({
      title: 'Not saved',
      description: e instanceof IpcError ? e.message : String(e),
      variant: 'error',
    });
  const save = useMutation({
    mutationFn: (zones: NonNullable<typeof parsed.value>) =>
      ipc.settings.saveDeliveryZones({ zones }),
    onSuccess: (next) => done('Saved', next),
    onError: failed,
  });
  const putBack = useMutation({
    mutationFn: () => ipc.settings.saveDeliveryZones({ useDefault: true }),
    onSuccess: (next) => done('Default put back', next),
    onError: failed,
  });

  const setRow = (id: string, patch: Partial<ZoneRow>) =>
    draft.set(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const toggleTick = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };
  const shown = parsed.value ?? card.value.zones;

  return (
    <SettingCard
      card={card}
      title="Delivery areas & fees"
      icon={<Bike className="h-5 w-5" />}
      intro="Where the shop delivers and what each area costs. Picking an area on a delivery order puts its fee on the bill by itself; the website charges the same and shows it on its pages."
      describe={zonesSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={save.isPending || putBack.isPending}
      onSave={() => parsed.value && save.mutate(parsed.value)}
      onPutBack={() => putBack.mutate()}
      footer={
        <div
          className="mt-4 space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100"
          aria-live="polite"
        >
          <p>
            <span className="font-semibold">For example: </span>
            {zonesExample(shown)}
          </p>
          <p className="text-xs">{ZONES_SAVE_NOTE}</p>
        </div>
      }
    >
      {groups.map((g) => (
        <div key={g}>
          <h3 className="mb-1 text-sm font-semibold">{g}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-stone-500">
                <th className="w-8 p-1">
                  <span className="sr-only">Tick</span>
                </th>
                <th className="p-1">Area</th>
                <th className="w-28 p-1">Chip</th>
                <th className="w-24 p-1">Fee (Rs)</th>
                <th className="w-16 p-1">On</th>
                <th className="w-20 p-1">
                  <span className="sr-only">Order</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.group.trim() === g)
                .map((r) => (
                  <tr
                    key={r.id}
                    className={cn(
                      'border-t border-stone-100 dark:border-stone-800',
                      !r.active && 'opacity-60',
                    )}
                  >
                    <td className="p-1">
                      <input
                        type="checkbox"
                        aria-label={`Tick ${r.name}`}
                        checked={ticked.has(r.id)}
                        onChange={() => toggleTick(r.id)}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        aria-label={`${r.savedName || r.name}: name`}
                        value={r.name}
                        onChange={(e) => setRow(r.id, { name: e.target.value })}
                        className={inputClass}
                      />
                      <details className="mt-1 text-xs text-stone-500">
                        <summary className="cursor-pointer">Spellings</summary>
                        <label className="mt-1 block">
                          Other names on an address (comma between)
                          <input
                            value={r.aliases}
                            onChange={(e) => setRow(r.id, { aliases: e.target.value })}
                            className={inputClass}
                          />
                        </label>
                        <label className="mt-1 block">
                          Search shortcuts (“6”, “block 5”)
                          <input
                            value={r.hints}
                            onChange={(e) => setRow(r.id, { hints: e.target.value })}
                            className={inputClass}
                          />
                        </label>
                      </details>
                    </td>
                    <td className="p-1">
                      <input
                        aria-label={`${r.name}: chip`}
                        value={r.shortName}
                        onChange={(e) => setRow(r.id, { shortName: e.target.value })}
                        className={inputClass}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        aria-label={`${r.name}: fee in rupees`}
                        inputMode="numeric"
                        value={r.fee}
                        onChange={(e) =>
                          setRow(r.id, { fee: e.target.value.replace(/[^\d,]/g, '').slice(0, 6) })
                        }
                        className={cn(inputClass, 'text-right')}
                      />
                    </td>
                    <td className="p-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Deliver to ${r.name}`}
                        checked={r.active}
                        onChange={(e) => setRow(r.id, { active: e.target.checked })}
                      />
                    </td>
                    <td className="p-1">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          aria-label={`Move ${r.name} up`}
                          onClick={() => draft.set(moveZoneRow(rows, r.id, -1))}
                          className="rounded p-1 hover:bg-stone-100 dark:hover:bg-stone-800"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${r.name} down`}
                          onClick={() => draft.set(moveZoneRow(rows, r.id, 1))}
                          className="rounded p-1 hover:bg-stone-100 dark:hover:bg-stone-800"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="flex flex-wrap items-end gap-2 rounded-lg bg-stone-50 p-3 dark:bg-stone-800/60">
        <div>
          <label className={labelClass} htmlFor="dz-bulk">
            Change the fee for the {ticked.size} ticked area{ticked.size === 1 ? '' : 's'} (Rs)
          </label>
          <input
            id="dz-bulk"
            inputMode="numeric"
            value={bulkFee}
            onChange={(e) => setBulkFee(e.target.value.replace(/[^\d,]/g, '').slice(0, 6))}
            className={cn(inputClass, 'w-32')}
          />
        </div>
        <Button
          variant="secondary"
          disabled={ticked.size === 0 || bulkFee.trim() === ''}
          onClick={() => draft.set(setFeeFor(rows, ticked, bulkFee))}
        >
          Set the fee
        </Button>
        <span className="text-xs text-stone-500">
          Whole rupees, Rs 0 to {formatCents(DELIVERY_FEE_MAX_CENTS, { showSymbol: false })}. Rs 0 =
          free delivery (no charge on the bill).
        </span>
      </div>

      <div className="rounded-lg border border-dashed border-stone-300 p-3 dark:border-stone-700">
        <h3 className="mb-2 text-sm font-semibold">Add an area</h3>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
          <label className="md:col-span-2">
            <span className={labelClass}>Name</span>
            <input
              value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
              placeholder="PECHS Block 6"
              className={inputClass}
            />
          </label>
          <label>
            <span className={labelClass}>Chip</span>
            <input
              value={adding.shortName}
              onChange={(e) => setAdding({ ...adding, shortName: e.target.value })}
              placeholder="Block 6"
              className={inputClass}
            />
          </label>
          <label>
            <span className={labelClass}>Group</span>
            <input
              list="dz-groups"
              value={adding.group}
              onChange={(e) => setAdding({ ...adding, group: e.target.value })}
              placeholder="PECHS"
              className={inputClass}
            />
            <datalist id="dz-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label>
            <span className={labelClass}>Fee (Rs)</span>
            <input
              inputMode="numeric"
              value={adding.fee}
              onChange={(e) =>
                setAdding({ ...adding, fee: e.target.value.replace(/[^\d,]/g, '').slice(0, 6) })
              }
              className={inputClass}
            />
          </label>
          <label className="md:col-span-4">
            <span className={labelClass}>Other spellings (comma between)</span>
            <input
              value={adding.aliases}
              onChange={(e) => setAdding({ ...adding, aliases: e.target.value })}
              placeholder="pechs 6, p.e.c.h.s block 6"
              className={inputClass}
            />
          </label>
          <div className="flex items-end">
            <Button
              variant="secondary"
              disabled={!adding.name.trim() || !adding.group.trim() || adding.fee.trim() === ''}
              onClick={() => {
                draft.set([...rows, newZoneRow(rows, adding)]);
                setAdding({ name: '', shortName: '', group: '', fee: '', aliases: '' });
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-stone-500">
          It works on the till and in the website’s checkout as soon as it is saved. An area’s id is
          made once from its name and never changes (the website and saved addresses use it).
        </p>
      </div>
    </SettingCard>
  );
}
