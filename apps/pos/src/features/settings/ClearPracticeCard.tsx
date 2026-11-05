import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import { Eraser, ShieldAlert } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { SecretInput } from '../../components/secret/SecretInput';
import {
  PRACTICE_CLEAR_CUSTOMERS_HELP,
  PRACTICE_CLEAR_DRAWER_HELP,
  PRACTICE_CLEAR_INTRO,
  PRACTICE_CLEAR_NOTE,
  PRACTICE_CLEAR_TITLE,
  customersLabel,
  drawerLogLabel,
  practiceClearMissing,
  practiceClearToast,
  practiceConfirmQuestion,
  practiceHistoryLine,
  practiceNothingToClear,
  showPracticeClear,
} from './practiceClearWords';

export const PRACTICE_PREVIEW_QUERY = ['practice', 'preview'] as const;

/**
 * Settings → About: "Clear practice orders", under the Licence card. Only the
 * owner's login, and only on a till with no licence key (practiceClearWords
 * showPracticeClear); the main process checks everything again.
 */
export function ClearPracticeCard() {
  const role = useSessionStore((st) => st.user?.role ?? null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const previewQ = useQuery({
    queryKey: PRACTICE_PREVIEW_QUERY,
    queryFn: () => ipc.practice.preview(),
    enabled: role === 'admin',
  });
  const [customers, setCustomers] = useState(false);
  const [drawerLog, setDrawerLog] = useState(false);
  const [secret, setSecret] = useState('');

  const clear = useMutation({
    mutationFn: () => ipc.practice.clear({ ownerSecret: secret, customers, drawerLog }),
    onSuccess: (r) => {
      setSecret('');
      setCustomers(false);
      setDrawerLog(false);
      toast({ title: practiceClearToast(r), variant: 'success' });
      // Orders, shifts, reports, customers: everything on screen may have changed.
      void qc.invalidateQueries();
    },
    onError: (e) =>
      toast({ title: 'Nothing was cleared', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const p = previewQ.data;
  if (!p || !showPracticeClear(role, p)) return null;

  const choice = { customers, drawerLog };
  const blocked = p.blocks.length > 0;
  const nothing = practiceNothingToClear(p, choice);
  const missing = practiceClearMissing({ blocked, nothing, secret });

  async function onClear() {
    if (!p || missing || clear.isPending) return;
    const yes = await askConfirm(practiceConfirmQuestion(p, choice), { yesLabel: 'Delete them', noLabel: 'Keep them', safeDefault: true });
    if (yes) clear.mutate();
  }

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Eraser className="h-5 w-5" />
        <h2 className="text-lg font-semibold">{PRACTICE_CLEAR_TITLE}</h2>
      </div>
      <p className="text-sm text-stone-700 dark:text-stone-200">{PRACTICE_CLEAR_INTRO}</p>
      <p className="mt-2 text-sm font-medium text-stone-800 dark:text-stone-100">{practiceHistoryLine(p)}</p>

      {blocked && (
        <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-900">
          {p.blocks.map((b) => (
            <li key={b.code + b.message} className="flex gap-2">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{b.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-3 border-t border-stone-200 pt-4 dark:border-stone-700">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-amber-500"
            checked={customers}
            disabled={p.customers === 0}
            onChange={(e) => setCustomers(e.target.checked)}
          />
          <span>
            <span className="font-medium">{customersLabel(p.customers)}</span>
            <span className="block text-xs text-stone-500">{PRACTICE_CLEAR_CUSTOMERS_HELP}</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-amber-500"
            checked={drawerLog}
            disabled={p.drawerLog === 0}
            onChange={(e) => setDrawerLog(e.target.checked)}
          />
          <span>
            <span className="font-medium">{drawerLogLabel(p.drawerLog)}</span>
            <span className="block text-xs text-stone-500">{PRACTICE_CLEAR_DRAWER_HELP}</span>
          </span>
        </label>
      </div>

      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/60 p-4 dark:border-stone-700 dark:bg-stone-900/40">
        <div className="text-sm font-semibold text-stone-700 dark:text-stone-200">Your owner PIN or password</div>
        <SecretInput value={secret} onChange={setSecret} wrapperClassName="mt-2" disabled={blocked || nothing || clear.isPending} />
        <p className="mt-2 text-xs text-stone-500">{PRACTICE_CLEAR_NOTE}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={() => void onClear()} disabled={!!missing || clear.isPending}>
            {clear.isPending ? 'Clearing…' : PRACTICE_CLEAR_TITLE}
          </Button>
          {missing && <span className="text-xs text-stone-500">{missing}</span>}
        </div>
      </div>
    </Card>
  );
}
