import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@cheeseoclock/ui';
import { SecretInput } from '../../components/secret/SecretInput';
import { answerManagerSecret, approvalPaperNote, useManagerApprovalStore } from './managerApproval';

/**
 * The manager's PIN or password for something the counter can't do alone —
 * printing a paid receipt or the shift report again. Mounted once at the root, next to
 * ConfirmHost; asked with askManagerSecret() (managerApproval.ts).
 */
export function ManagerApprovalHost() {
  const ask = useManagerApprovalStore((s) => s.ask);
  const [secret, setSecret] = useState('');
  useEffect(() => setSecret(''), [ask]);
  if (!ask) return null;
  const approve = () => answerManagerSecret(secret);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && answerManagerSecret(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <Dialog.Title className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5 text-amber-600" />
            Manager approval
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-stone-600 dark:text-stone-400">{ask.message}</Dialog.Description>
          <p className="mt-2 text-xs text-stone-500">{ask.paperNote ?? approvalPaperNote(ask.printNo)}</p>
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              approve();
            }}
          >
            <SecretInput
              autoFocus
              value={secret}
              onChange={setSecret}
              aria-label="Manager PIN or password"
              wrapperClassName="flex gap-2"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-lg tracking-widest dark:border-stone-700 dark:bg-stone-800"
            />
            {ask.error && (
              <p role="alert" className="mt-2 text-sm font-medium text-red-600 dark:text-red-400">
                {ask.error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => answerManagerSecret(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!secret.trim()}>
                Approve and print
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
