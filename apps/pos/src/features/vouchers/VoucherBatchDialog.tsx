import { getShopLocale, shopIsInPakistan } from '@cheeseoclock/shared-types';
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp, X } from 'lucide-react';
import { Button, cn } from '@cheeseoclock/ui';
import { parseVoucherList } from '@cheeseoclock/pos-domain';
import { VOUCHER_BATCH_MAX, type VoucherBatchSummary } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { pastedListWords, rupeesToCents, voucherFileProblem } from './voucherPageWords';

interface Props {
  /** The batch to change; none = add new vouchers. */
  batch?: VoucherBatchSummary;
  onClose: () => void;
  onSaved: (batch: VoucherBatchSummary) => void;
}

const INPUT =
  'w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800';

/**
 * Add a client's vouchers, or change a batch (v0.7.48). Who they are for
 * (prints on the bill), what one gets (shown at the till), the most one takes
 * off, and its last day if it has one. New vouchers come as printed — a CSV
 * file chosen here (v0.7.49; the owner: "i just want to upload csv into the
 * pos so it get it all"), or the list pasted, "001 AB3C" a line — or the
 * till makes the codes, to hand to whoever prints them. The file fills the
 * list, so the owner sees what was read before Add vouchers.
 */
export function VoucherBatchDialog({ batch, onClose, onSaved }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(batch?.name ?? '');
  const [gives, setGives] = useState(batch?.gives ?? 'One Large pizza from the Regular menu');
  const [covers, setCovers] = useState(batch ? String(batch.coversCents / 100) : '');
  const [hasEnd, setHasEnd] = useState(batch?.goodUntil != null);
  const [goodUntil, setGoodUntil] = useState(batch?.goodUntil ?? '');
  const [from, setFrom] = useState<'list' | 'make'>('list');
  const [listText, setListText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [countText, setCountText] = useState('100');
  const [firstText, setFirstText] = useState('1');
  const [error, setError] = useState<string | null>(null);

  const read = useMemo(() => parseVoucherList(listText), [listText]);
  const listWords = pastedListWords(read);
  const coversCents = rupeesToCents(covers);
  const count = /^\d+$/.test(countText) ? Number(countText) : 0;
  const first = /^\d+$/.test(firstText) ? Number(firstText) : 0;

  const problem = (() => {
    if (name.trim() === '') return 'Say who the vouchers are for';
    if (gives.trim() === '') return 'Say what one voucher gets';
    if (coversCents === null) return `Say the most one voucher takes off, in ${getShopLocale().words.major}`;
    if (hasEnd && !/^\d{4}-\d{2}-\d{2}$/.test(goodUntil)) return 'Pick the last day, or untick it';
    if (batch) return null;
    if (from === 'list') {
      if (read.vouchers.length === 0) return 'Choose the CSV file of the vouchers, or paste the list';
      if (read.vouchers.length > VOUCHER_BATCH_MAX) return `At most ${VOUCHER_BATCH_MAX} vouchers at a time`;
      return listWords.problems[0] ?? null;
    }
    if (count < 1 || count > VOUCHER_BATCH_MAX) return `Make 1 to ${VOUCHER_BATCH_MAX} vouchers`;
    if (first < 1) return 'The first number is 1 or more';
    return null;
  })();

  /** A CSV (or text) file of the vouchers: read here, into the list, never sent anywhere as a file. */
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    const tooBig = voucherFileProblem(file.size);
    if (tooBig) {
      setError(tooBig);
      return;
    }
    try {
      setListText(await file.text());
      setFileName(file.name);
    } catch {
      setError('That file could not be read. Save it as CSV and choose it again.');
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const fields = { name, gives, coversCents: coversCents ?? 0, goodUntil: hasEnd ? goodUntil : null };
      if (batch) return ipc.vouchers.updateBatch({ id: batch.id, ...fields });
      return from === 'list'
        ? ipc.vouchers.addBatch({ ...fields, from: 'list', vouchers: read.vouchers })
        : ipc.vouchers.addBatch({ ...fields, from: 'make', count, firstNumber: first });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['vouchers'] });
      toast({
        title: batch ? 'Vouchers changed' : `${saved.count} vouchers added`,
        description: `${saved.name} · ${saved.gives}`,
        variant: 'success',
      });
      onSaved(saved);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save the vouchers'),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-24px)] w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <Dialog.Title className="text-lg font-bold">{batch ? 'Change these vouchers' : 'Add vouchers'}</Dialog.Title>
              <Dialog.Description className="text-sm text-stone-500">
                {batch
                  ? 'The vouchers stay as printed. Orders already using one keep what it covered then.'
                  : 'Vouchers a client bought to hand out. Each one is used once, at the till, with its number and code.'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-lg p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Close">
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (problem) {
                setError(problem);
                return;
              }
              save.mutate();
            }}
          >
            <label className="block">
              <span className="mb-1 block text-sm font-semibold">Who they are for</span>
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="abhi" className={INPUT} />
              <span className="mt-1 block text-xs text-stone-500">Prints on the bill: “Voucher No. 001 · {name.trim() || 'abhi'}”.</span>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-semibold">What one voucher gets</span>
              <input value={gives} maxLength={80} onChange={(e) => setGives(e.target.value)} className={INPUT} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-sm font-semibold">Covers up to ({getShopLocale().symbol})</span>
                <input inputMode="decimal" value={covers} onChange={(e) => setCovers(e.target.value)} placeholder={shopIsInPakistan() ? '1899' : '20'} className={INPUT} />
                <span className="mt-1 block text-xs text-stone-500">The price of that item. A dearer one: the rest is paid.</span>
              </label>
              <div>
                <label className="mb-1 flex items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" checked={hasEnd} onChange={(e) => setHasEnd(e.target.checked)} />
                  Last day to use them
                </label>
                {hasEnd ? (
                  <input type="date" value={goodUntil} onChange={(e) => setGoodUntil(e.target.value)} className={INPUT} />
                ) : (
                  <p className="text-sm text-stone-500">No end date</p>
                )}
              </div>
            </div>

            {!batch && (
              <section className="space-y-2 rounded-xl border border-stone-200 p-3 dark:border-stone-700">
                <div className="flex gap-2" role="radiogroup" aria-label="The vouchers">
                  {(
                    [
                      ['list', 'From a CSV file'],
                      ['make', 'Make new codes'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={from === id}
                      onClick={() => setFrom(id)}
                      className={cn(
                        'rounded-full px-3 py-1 text-sm font-semibold ring-1',
                        from === id ? 'bg-stone-900 text-white ring-stone-900 dark:bg-amber-500 dark:text-stone-900' : 'ring-stone-200 dark:ring-stone-700',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {from === 'list' ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                        <FileUp className="h-4 w-4" />
                        Choose a CSV file
                      </Button>
                      <span className="text-xs text-stone-500">
                        {fileName ? `Read from ${fileName}` : 'Number and code on each line (001,AB3C). Or paste the list below.'}
                      </span>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".csv,.txt,text/csv,text/plain"
                        className="hidden"
                        aria-label="The CSV file of the vouchers"
                        onChange={(e) => void onFile(e)}
                      />
                    </div>
                    <textarea
                      value={listText}
                      onChange={(e) => {
                        setListText(e.target.value);
                        setFileName(null);
                      }}
                      rows={7}
                      spellCheck={false}
                      placeholder={'001 AB3C\n002 XK7P\n003 RT9D'}
                      aria-label="The vouchers, one a line: number then code"
                      className={cn(INPUT, 'font-mono')}
                    />
                    <p className="text-sm font-medium">{listWords.summary}</p>
                    {listWords.problems.map((p) => (
                      <p key={p} className="text-sm font-semibold text-red-600 dark:text-red-400">
                        {p}
                      </p>
                    ))}
                    {listWords.skipped && <p className="text-xs text-stone-500">{listWords.skipped}</p>}
                  </>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-sm font-semibold">How many</span>
                      <input inputMode="numeric" value={countText} onChange={(e) => setCountText(e.target.value.replace(/\D/g, ''))} className={INPUT} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-semibold">First number</span>
                      <input inputMode="numeric" value={firstText} onChange={(e) => setFirstText(e.target.value.replace(/\D/g, ''))} className={INPUT} />
                    </label>
                    <p className="col-span-2 text-xs text-stone-500">
                      The till makes a 4-letter code for each, none like another voucher’s. Copy the list afterwards for whoever prints them.
                    </p>
                  </div>
                )}
              </section>
            )}

            {error && (
              <p role="alert" className="text-sm font-semibold text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : batch ? 'Save' : 'Add vouchers'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
