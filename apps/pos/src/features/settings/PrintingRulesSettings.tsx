import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import {
  KITCHEN_COPIES_MAX,
  kitchenTicketRules,
  SHIFT_REPORT_SECTIONS,
  shiftReportRules,
  type PrintPolicy,
  type ReceiptLogoStatus,
  type ShiftReportItemsShown,
  type ShiftReportRules,
  type ShiftReportSection,
  type ShopCopyRule,
} from '@cheeseoclock/shared-types';
import { Bike, ChefHat, ClipboardList, Copy, CupSoda, Image as ImageIcon, Phone, Receipt, RotateCcw, ScrollText } from 'lucide-react';
import { darkLogoFix } from './receiptLogo';
import { reprintRuleText } from './shop-rules/timingWords';
import { SHOP_SETTINGS_KEY, useShopSettingsLive } from './shop-rules/useShopSetting';
import { kitchenTicketText, printPolicyDiffers } from './shop-rules/printingWords';

const DEFAULT_POLICY: PrintPolicy = {
  kitchenTicket: true,
  deliveryBillOnDispatch: true,
  shopCopy: 'delivery',
  logoOnReceipt: true,
};

/** What the "Logo on receipts" rule says, from what the till will really do with the logo. */
function logoRuleBody(status: ReceiptLogoStatus | undefined, logoUrl: string | undefined): string {
  if (!logoUrl || !status || status.state === 'none') {
    return 'No logo yet. The owner can add one under Settings → Shop & logo.';
  }
  switch (status.state) {
    case 'not_ready':
      return 'The logo is being made ready for the printer; this takes a moment. Until then receipts print without it.';
    case 'blank':
      return 'Your logo is too light to print, so receipts leave it out. The owner can upload a darker one under Settings → Shop & logo.';
    case 'too_dark':
      return `Your logo would print as a big black block, so receipts leave it out. The owner can upload ${darkLogoFix(logoUrl)} under Settings → Shop & logo.`;
    default:
      return "Your logo prints at the top of customer receipts, delivery bills and refund slips, in place of the shop name — never on kitchen tickets. Turned off, they start with the shop name. The receipt printer's Test print shows it even when this is off. If it comes out as odd symbols, your printer can't print pictures: turn this off.";
  }
}

const SHOP_COPY_OPTIONS: Array<{ id: ShopCopyRule; label: string }> = [
  { id: 'never', label: 'Never' },
  { id: 'delivery', label: 'With delivery bills' },
  { id: 'always', label: 'With every receipt' },
];

// The shift report (v0.7.35; the owner, 2 Oct 2026: "all orders and totals
// also add seetngs so we can customize"). This till only, the owner's alone
// (printer.manage); the paper's footer points back here.
export const SHIFT_REPORT_RULE_BODY =
  "Prints on this till's receipt printer when a shift closes, after the count is saved. Set it on each till. The till always saves every section; switching one off only leaves it off the paper. Print any shift again from Reports → Team & leakage → Shift history. Food cost and profit never print.";
export const SHIFT_REPORT_SWITCH = 'Print the shift report when a shift closes';
export const SHIFT_REPORT_SECTIONS_TITLE = 'Sections on the paper';
export const SHIFT_REPORT_SECTIONS_NOTE =
  'All on at first. Every print follows them, at the close or from Shift history. When one is off, the paper ends with "Some sections are off. See Settings > Printers."';
/** The radiogroup beside the "Items sold" switch. */
export const SHIFT_REPORT_ITEMS_GROUP = 'Items sold';

const SHIFT_REPORT_ITEMS_OPTIONS: Array<{ id: ShiftReportItemsShown; label: string }> = [
  { id: 'items', label: 'Every item' },
  { id: 'categories', label: 'Category totals' },
];

/**
 * What prints automatically, and when. The rules live in the main process
 * (Settings → Printer → policy); this card only edits them. The wording here
 * is the contract the shop runs on, so keep it in step with
 * PrintPolicy in shared-types and printSpooler.onOrderEvent.
 */
export function PrintingRulesSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
  });
  // Starts from the saved rules when they are already read (no flash of the defaults), else the defaults until they are.
  const [policy, setPolicy] = useState<PrintPolicy>(() => cfgQ.data?.policy ?? DEFAULT_POLICY);
  // Hydrate from the saved rules only: saving a printer on this tab must not
  // wipe a rule that was changed here but not saved yet.
  const savedPolicy = cfgQ.data?.policy;
  useEffect(() => {
    if (savedPolicy) setPolicy(savedPolicy);
  }, [savedPolicy]);

  const saveMut = useMutation({
    mutationFn: (next: PrintPolicy) => ipc.printer.setPolicy(next),
    onSuccess: () => {
      toast({ title: 'Printing rules saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['printer', 'config'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  // The owner's reprint rule (Settings → Staff & kitchen timing): the words follow it, and a Save
  // (here or on the other till) re-reads it.
  useShopSettingsLive();
  const staffQ = useQuery({
    queryKey: [...SHOP_SETTINGS_KEY, 'staff.timing'],
    queryFn: () => ipc.settings.getBusiness('staff.timing'),
    retry: false,
  });

  const saved = cfgQ.data?.policy ?? DEFAULT_POLICY;
  const dirty = printPolicyDiffers(saved, policy);
  const logoUrl = cfgQ.data?.branding.logoUrl;
  // This till's kitchen-ticket rules, the released ones (1 ticket, phone and drinks on) where none is saved.
  const kitchen = kitchenTicketRules(policy);
  // This till's shift report rules: on, every section, every item where none is saved (a policy from before 0.7.35).
  const shiftReport = shiftReportRules(policy);
  // A section switched writes all nine, so what is saved is what the switches
  // show. Each change builds on the rules as they are by then (two quick taps keep both).
  const setShiftReportSection = (key: ShiftReportSection, on: boolean) =>
    setPolicy((p) => ({ ...p, shiftReportSections: { ...shiftReportRules(p).sections, [key]: on } }));
  const shiftReportIds = useId();

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <ScrollText className="h-5 w-5" />
        <h2 className="text-lg font-semibold">What prints, and when</h2>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Paper comes out on its own at these moments. Nothing here ever blocks a sale: if the
        printer is off, the order is still saved and the print retries.
      </p>

      <ul className="divide-y divide-stone-200 dark:divide-stone-700">
        <Rule
          icon={ChefHat}
          title="Kitchen ticket"
          body={kitchenTicketText(policy)}
          control={
            <Toggle
              checked={policy.kitchenTicket}
              onChange={(v) => setPolicy({ ...policy, kitchenTicket: v })}
              label="Print kitchen tickets"
            />
          }
        />
        {policy.kitchenTicket && (
          <>
            <Rule
              icon={Copy}
              title="Kitchen tickets per order"
              body={
                kitchen.copies === 1
                  ? 'One ticket an order. More helps when two stations cook from paper (the oven and the fryer): each copy says which it is, so an order is never cooked twice.'
                  : `${kitchen.copies} tickets an order, printed together and marked ${copyMarks(kitchen.copies)}, so an order is never cooked twice. A CANCELLED slip prints as many. This till only.`
              }
              control={
                <div className="flex gap-1" role="radiogroup" aria-label="Kitchen tickets per order">
                  {Array.from({ length: KITCHEN_COPIES_MAX }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={kitchen.copies === n}
                      onClick={() => setPolicy({ ...policy, kitchenCopies: n })}
                      className={cn(
                        'rounded-lg border-2 px-3 py-1.5 text-xs font-semibold transition-colors',
                        kitchen.copies === n
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              }
            />
            <Rule
              icon={Phone}
              title="Customer's phone on kitchen tickets"
              body={
                kitchen.phone
                  ? "The customer's phone prints beside their name, so the kitchen can call about an order."
                  : "Only the customer's name prints: the phone stays off paper that sits on the kitchen rail."
              }
              control={
                <Toggle
                  checked={kitchen.phone}
                  onChange={(v) => setPolicy({ ...policy, kitchenPhone: v })}
                  label="Print the customer's phone on kitchen tickets"
                />
              }
            />
            <Rule
              icon={CupSoda}
              title="Drinks on kitchen tickets"
              body={
                kitchen.drinks
                  ? 'Drinks are listed with the food.'
                  : 'Drinks (items in a Drinks or Beverages category, or sent to the bar) are left off; one line says how many the counter hands out. An order of only drinks prints no kitchen ticket.'
              }
              control={
                <Toggle
                  checked={kitchen.drinks}
                  onChange={(v) => setPolicy({ ...policy, kitchenDrinks: v })}
                  label="List drinks on kitchen tickets"
                />
              }
            />
          </>
        )}
        <Rule
          icon={Receipt}
          title="Customer receipt"
          body="Printed when money is taken: Pay now at the counter, or a cash-on-delivery order marked served or delivered with its payment. A cash payment opens the drawer straight away, before anything prints; card and wallet payments do not."
          control={<span className="text-xs font-semibold uppercase tracking-wider text-stone-400">Always</span>}
        />
        <Rule
          icon={ImageIcon}
          title="Logo on receipts"
          body={logoRuleBody(cfgQ.data?.logo, logoUrl)}
          control={
            <Toggle
              checked={policy.logoOnReceipt}
              onChange={(v) => setPolicy({ ...policy, logoOnReceipt: v })}
              label="Print the logo on receipts"
            />
          }
        />
        <Rule
          icon={Bike}
          title="Delivery bill goes with the rider"
          body="For delivery orders the bill prints when the order goes out — Send out, or Assign rider — so it travels with the food and shows the amount to collect, or PAID. It prints once per order, on either till. When the rider brings the money back, only the drawer opens."
          control={
            <Toggle
              checked={policy.deliveryBillOnDispatch}
              onChange={(v) => setPolicy({ ...policy, deliveryBillOnDispatch: v })}
              label="Print the bill when the order goes out"
            />
          }
        />
        <Rule
          icon={Copy}
          title="Shop copy"
          body="A second copy marked SHOP COPY, with a Received-by line for the rider or customer to sign. The shop keeps it to check the day's cash."
          control={
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Shop copy">
              {SHOP_COPY_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={policy.shopCopy === o.id}
                  onClick={() => setPolicy({ ...policy, shopCopy: o.id })}
                  className={cn(
                    'rounded-lg border-2 px-3 py-1.5 text-xs font-semibold transition-colors',
                    policy.shopCopy === o.id
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                      : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          }
        />
        <Rule
          icon={RotateCcw}
          title="Refunds and reprints"
          body={`Every paper says what it is. A paid receipt says RECEIPT and PAID - CASH (or the method); a bill before payment says BILL - NOT PAID, and a delivery bill says CASH ON DELIVERY and what the rider collects. A refund prints a REFUND slip (the drawer opens when cash goes back out, and a cash refund also prints a SHOP COPY for the customer to sign, unless shop copies are set to Never); a cancelled order only ever prints as CANCELLED ORDER - nothing to pay. Any second copy of a receipt or bill says DUPLICATE at the top, in the middle and at the bottom, with the reprint number, time and who asked; a printer retry says so too. The till prints a customer paper by itself only when money moves or the rider leaves: the receipt at Pay, the receipt when an order is paid as it is served or handed over, the delivery bill when the rider leaves (when that is on), and the refund slip. That paper is the original. Any paper printed with a print button (Order History, Recent Orders, Live Orders, the order panel, the payment screen) says DUPLICATE, even the first one of its kind. So a bill asked for before payment, for a table or a website order waiting for pick-up, always says DUPLICATE: the till never prints one by itself at Send or when a website order comes in. Only “Try again” on a failed print, or “Print the receipt that failed” in the order panel, sends that original again. A bill and the paid receipt are different papers. ${reprintRuleText(staffQ.data?.value ?? null)} A reprinted kitchen ticket says REPRINT - SAME ORDER, DO NOT COOK TWICE, and a cancelled one CANCELLED - DO NOT MAKE. Reprints never open the drawer and never go to FBR again; every paper is kept in the audit trail.`}
          control={<span className="text-xs font-semibold uppercase tracking-wider text-stone-400">Always</span>}
        />
        <Rule
          icon={ClipboardList}
          title="Shift report"
          body={SHIFT_REPORT_RULE_BODY}
          control={
            <Toggle
              checked={shiftReport.onClose}
              onChange={(v) => setPolicy((p) => ({ ...p, shiftReportOnClose: v }))}
              label={SHIFT_REPORT_SWITCH}
            />
          }
        >
          {shiftReportSections({
            rules: shiftReport,
            idBase: shiftReportIds,
            onSection: setShiftReportSection,
            onItems: (items) => setPolicy((p) => ({ ...p, shiftReportItems: items })),
          })}
        </Rule>
      </ul>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-stone-200 pt-4 dark:border-stone-700">
        {dirty && (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Your changes are not saved yet
          </span>
        )}
        <Button
          variant="primary"
          disabled={saveMut.isPending || !dirty}
          onClick={() => saveMut.mutate(policy)}
        >
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

/** "COPY 1 OF 2 and COPY 2 OF 2", "COPY 1 OF 3, COPY 2 OF 3 and COPY 3 OF 3". */
function copyMarks(n: number): string {
  const marks = Array.from({ length: n }, (_, i) => `COPY ${i + 1} OF ${n}`);
  return marks.length <= 1 ? (marks[0] ?? '') : `${marks.slice(0, -1).join(', ')} and ${marks[marks.length - 1]}`;
}

/**
 * One printing rule: its icon, title and words, and its control. `children`
 * (more controls that belong to it) go under the whole row, lined up with
 * the words, after its control.
 */
function Rule(props: {
  icon: typeof ChefHat;
  title: string;
  body: string;
  control: React.ReactNode;
  children?: React.ReactNode;
}) {
  const Icon = props.icon;
  const row = (
    <>
      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{props.title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{props.body}</p>
        </div>
      </div>
      <div className="shrink-0 md:pl-4">{props.control}</div>
    </>
  );
  if (props.children === undefined) {
    return <li className="flex flex-col gap-3 py-4 md:flex-row md:items-start md:justify-between">{row}</li>;
  }
  return (
    <li className="py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">{row}</div>
      <div className="mt-3 pl-11">{props.children}</div>
    </li>
  );
}

/**
 * The shift report's nine sections, one switch each in the order they print
 * (SHIFT_REPORT_SECTIONS), all on at first; "Items sold" carries its choice
 * of every item or the category totals, which waits while that section is
 * off. A switch changes only what prints: the close saves every section.
 * Under the "Shift report" rule's words. Made in the card's own render, as
 * the kitchen rules are (a plain function, not a component of its own).
 */
function shiftReportSections(props: {
  rules: ShiftReportRules;
  /** The card's useId(): each switch's id, for the label beside it. */
  idBase: string;
  onSection: (key: ShiftReportSection, on: boolean) => void;
  onItems: (items: ShiftReportItemsShown) => void;
}): React.ReactNode {
  const { rules, idBase } = props;
  const itemsOn = rules.sections.items;
  return (
    <div role="group" aria-label={SHIFT_REPORT_SECTIONS_TITLE}>
      <div className="text-sm font-semibold">{SHIFT_REPORT_SECTIONS_TITLE}</div>
      <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{SHIFT_REPORT_SECTIONS_NOTE}</p>
      <ul className="mt-2 space-y-1">
        {SHIFT_REPORT_SECTIONS.map((s) => {
          const id = `${idBase}-${s.key}`;
          return (
            <li key={s.key} className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
              <Toggle id={id} checked={rules.sections[s.key]} onChange={(v) => props.onSection(s.key, v)} label={s.label} />
              <label htmlFor={id} className="cursor-pointer text-sm">
                {s.label}
              </label>
              {s.key === 'items' && (
                <div className="flex gap-1 sm:ml-3" role="radiogroup" aria-label={SHIFT_REPORT_ITEMS_GROUP} aria-disabled={!itemsOn}>
                  {SHIFT_REPORT_ITEMS_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={rules.items === o.id}
                      disabled={!itemsOn}
                      onClick={() => props.onItems(o.id)}
                      className={cn(
                        'rounded-lg border-2 px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        rules.items === o.id
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={props.id}
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        props.checked ? 'bg-amber-500' : 'bg-stone-300 dark:bg-stone-600',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          props.checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
