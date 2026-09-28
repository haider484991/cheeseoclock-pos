/**
 * Settings → Shop & logo → Extra lines on receipts ('receipt.extraLines',
 * this till only, like the rest of the receipt branding): up to three lines
 * of the owner's under the thank-you line — Instagram, the Wi-Fi password,
 * an offer — on the customer's receipt and bill. The owner alone (the main
 * process refuses anyone else). None by default: the papers print exactly
 * as before.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquarePlus } from 'lucide-react';
import { DEFAULT_FOOTER_LINE, toPrinterAscii, wrap } from '@cheeseoclock/printer-core';
import { RECEIPT_EXTRA_LINE_MAX_CHARS, type TillSettingCard } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useTillSetting } from './shop-rules/useTillSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  extraLinesExample,
  extraLinesFromForm,
  extraLinesSummary,
  extraLinesToForm,
  extraLinesWarnings,
} from './shop-rules/tillSettingsForm';

export function ReceiptExtraLinesCard() {
  const s = useTillSetting('receipt.extraLines');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load the extra receipt lines.</p>;
  if (!s.q.data) return <p className="py-6 text-center text-stone-500">Loading…</p>;
  return <ExtraLinesForm s={s} card={s.q.data} />;
}

function ExtraLinesForm({
  s,
  card,
}: {
  s: ReturnType<typeof useTillSetting<'receipt.extraLines'>>;
  card: TillSettingCard<'receipt.extraLines'>;
}) {
  const d = useDraft<string[], string[]>(card.value, extraLinesToForm);
  const parsed = useMemo(() => extraLinesFromForm(d.form), [d.form]);
  const warnings = useMemo(() => extraLinesWarnings(d.form), [d.form]);
  const dirty = d.touched && (parsed.value === null || !sameValue(parsed.value, card.value));
  // The preview uses this till's paper width and its thank-you line.
  const cfgQ = useQuery({ queryKey: ['printer', 'config'], queryFn: () => ipc.printer.getConfig() });
  const paper = cfgQ.data?.config.width ?? 48;
  const thanks = cfgQ.data?.branding.footerLine?.trim() || DEFAULT_FOOTER_LINE;
  const shown = parsed.value ?? card.value;

  return (
    <SettingCard
      card={card}
      scope="till"
      title="Extra lines on receipts"
      icon={<MessageSquarePlus className="h-5 w-5" />}
      intro="Up to three lines of your own under the thank-you line on customer receipts and bills: your Instagram, the Wi-Fi password, an offer."
      describe={extraLinesSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: d.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: d.reset })}
      footer={
        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
            <span className="font-semibold">For example: </span>
            {extraLinesExample(shown)}
          </p>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">Bottom of a receipt</div>
            <div className="bg-white px-3 py-3 text-center font-mono text-[11px] leading-snug text-stone-900 shadow-soft ring-1 ring-stone-200">
              {/* What the printer puts on paper: its letters, wrapped at this till's paper width. */}
              {[thanks, ...shown].flatMap((line, i) =>
                wrap(toPrinterAscii(line), paper).map((row, j) => (
                  <div key={`${i}-${j}`} className={i === 0 ? 'text-stone-400' : 'break-words'}>
                    {row}
                  </div>
                )),
              )}
            </div>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {d.form.map((text, i) => (
          <label key={i} className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Line {i + 1}</span>
            <input
              type="text"
              value={text}
              maxLength={RECEIPT_EXTRA_LINE_MAX_CHARS + 10}
              onChange={(e) => d.set(d.form.map((t, j) => (j === i ? e.target.value : t)))}
              placeholder={i === 0 ? 'Instagram @yourshop' : i === 1 ? 'Wi-Fi: YourShop / password' : 'Show this receipt for 10% off'}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60"
            />
            <span className="mt-0.5 block text-right text-xs text-stone-400">
              {text.trim().length} / {RECEIPT_EXTRA_LINE_MAX_CHARS}
            </span>
          </label>
        ))}
        {warnings.map((w) => (
          <p key={w} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {w}
          </p>
        ))}
      </div>
    </SettingCard>
  );
}
