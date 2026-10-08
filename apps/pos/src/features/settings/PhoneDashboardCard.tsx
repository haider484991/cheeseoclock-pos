/**
 * Settings → Online orders → Phone dashboard (v0.7.40; the user, 8 Oct 2026:
 * "the site should have a login for the owner or manager to check it on
 * their phone anytime"). The owner's:
 *
 *  - whether this till sends its figures, where it stands, "Send now";
 *  - the people who can sign in — kept on the website, the same list on
 *    both tills: add one (name, username, owner or manager, and for a
 *    manager whether they also see reports and past shifts), change one,
 *    make a new setup code (a forgotten password, a new phone), sign them
 *    out of every phone, remove them.
 *
 * A setup code is made on this till and shown ONCE, in a window that closes
 * only with its own buttons, kept in that window's state and nowhere else;
 * the website holds only its SHA-256. Nobody signs in to the dashboard with
 * a till PIN.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { Copy, KeyRound, LogOut, Pencil, RefreshCw, Smartphone, Trash2, UserPlus, X } from 'lucide-react';
import { DASH_DISPLAY_NAME_MAX, type DashLoginMade, type DashLoginView, type DashRole } from '@cheeseoclock/shared-types';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { KEY_DIALOG_STAYS_OPEN } from './shop-rules/menuDeployWords';
import {
  CODE_DAYS,
  NEW_CODE_QUESTION,
  REMOVE_QUESTION,
  SIGN_OUT_QUESTION,
  loginStateText,
  pushStatusText,
  roleText,
  setupMessage,
} from './shop-rules/phoneDashboardWords';

const TONE_CLASS = {
  good: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100',
  warn: 'bg-amber-50 text-amber-950 dark:bg-amber-950/60 dark:text-amber-100',
  plain: 'bg-stone-50 text-stone-800 dark:bg-stone-800/60 dark:text-stone-100',
} as const;

export const DASH_STATUS_KEY = ['dashboard', 'status'] as const;
export const DASH_LOGINS_KEY = ['dashboard', 'logins'] as const;

const said = (e: unknown) => (e instanceof IpcError ? e.message : String(e));

export function PhoneDashboardCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const statusQ = useQuery({ queryKey: DASH_STATUS_KEY, queryFn: () => ipc.dashboard.getStatus(), refetchInterval: 15_000 });
  const status = statusQ.data;
  const loginsQ = useQuery({
    queryKey: DASH_LOGINS_KEY,
    queryFn: () => ipc.dashboard.listLogins(),
    enabled: status !== undefined && status.phase !== 'not_linked' && status.phase !== 'website_old',
    retry: false,
    // The list lives on the website and changes on the person's phone: read it afresh each time the card
    // opens, and every minute while someone's setup code is out, so "Waiting to set up" turns into
    // "signed in" by itself. Never otherwise: each look wakes the website's database.
    refetchOnMount: 'always',
    refetchInterval: (q) => (q.state.data?.some((l) => l.setupPending) ? 60_000 : false),
  });
  const [made, setMade] = useState<(DashLoginMade & { displayName: string }) | null>(null);
  const [editing, setEditing] = useState<DashLoginView | 'new' | null>(null);

  const setList = (logins: DashLoginView[]) => qc.setQueryData(DASH_LOGINS_KEY, logins);
  const fail = (title: string) => (e: unknown) => toast({ title, description: said(e), variant: 'error' });

  const toggle = useMutation({
    mutationFn: (on: boolean) => ipc.dashboard.setOn(on),
    onSuccess: (s) => qc.setQueryData(DASH_STATUS_KEY, s),
    onError: fail('Not changed'),
  });
  const pushNow = useMutation({
    mutationFn: () => ipc.dashboard.pushNow(),
    onSuccess: (s) => {
      qc.setQueryData(DASH_STATUS_KEY, s);
      // The push runs by itself; look again in a moment.
      setTimeout(() => void qc.invalidateQueries({ queryKey: DASH_STATUS_KEY }), 4_000);
    },
    onError: fail('Could not send now'),
  });
  const newCode = useMutation({
    mutationFn: (l: DashLoginView) => ipc.dashboard.newCode(l.id).then((m) => ({ ...m, displayName: l.displayName })),
    gcTime: 0,
    onSuccess: (m) => {
      setList(m.logins);
      setMade(m);
    },
    onError: fail('No new setup code'),
  });
  const signOut = useMutation({
    mutationFn: (l: DashLoginView) => ipc.dashboard.signOutAll(l.id),
    onSuccess: (logins) => {
      setList(logins);
      toast({ title: 'Signed out of every phone', variant: 'success' });
    },
    onError: fail('Not signed out'),
  });
  const remove = useMutation({
    mutationFn: (l: DashLoginView) => ipc.dashboard.removeLogin(l.id),
    onSuccess: (logins) => {
      setList(logins);
      toast({ title: 'Removed from the phone dashboard', variant: 'success' });
    },
    onError: fail('Not removed'),
  });

  const line = status ? pushStatusText(status) : null;
  const linked = status !== undefined && status.phase !== 'not_linked';
  return (
    <Card>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Smartphone className="h-5 w-5" /> Phone dashboard
      </h2>
      <p className="mt-0.5 text-sm text-stone-500">
        Orders, shifts and cash, stock, the menu and sales on the owner’s and managers’ phones
        {status?.dashboardUrl ? (
          <>
            {' '}
            at <span className="font-medium text-stone-700 dark:text-stone-200">{status.dashboardUrl}</span>
          </>
        ) : null}
        . Each person signs in with their own password — never a till PIN.
      </p>

      {statusQ.isError && <p className="mt-3 text-sm text-stone-500">Could not read where this till stands.</p>}
      {line && (
        <div className="mt-3 space-y-3">
          <p className={cn('rounded-lg p-3 text-sm', TONE_CLASS[line.tone])} aria-live="polite">
            {line.text}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 accent-amber-500"
                checked={status?.on ?? true}
                disabled={toggle.isPending}
                onChange={(e) => toggle.mutate(e.target.checked)}
              />
              Send this till’s figures to the dashboard
            </label>
            <Button variant="secondary" size="sm" onClick={() => pushNow.mutate()} disabled={pushNow.isPending || !linked || !status?.on}>
              <RefreshCw className={cn('mr-1 h-4 w-4', pushNow.isPending && 'animate-spin')} /> Send now
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Who can sign in</h3>
          <Button size="sm" onClick={() => setEditing('new')} disabled={!linked || loginsQ.isError}>
            <UserPlus className="mr-1 h-4 w-4" /> Add a person
          </Button>
        </div>
        {!linked && <p className="mt-2 text-sm text-stone-500">Set up the website link first.</p>}
        {loginsQ.isError && <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">{said(loginsQ.error)}</p>}
        {loginsQ.data && loginsQ.data.length === 0 && (
          <p className="mt-2 text-sm text-stone-500">Nobody yet. Add yourself first (as the owner), then your managers.</p>
        )}
        {loginsQ.data && loginsQ.data.length > 0 && (
          <ul className="mt-2 divide-y divide-stone-200 dark:divide-stone-700">
            {loginsQ.data.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {l.displayName} <span className="font-mono text-sm text-stone-500">({l.username})</span>
                  </p>
                  <p className="text-xs text-stone-500">{roleText(l)}</p>
                  <p className="text-xs text-stone-500">{loginStateText(l)}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={newCode.isPending}
                    onClick={() => {
                      void askConfirm(NEW_CODE_QUESTION(l.displayName), { yesLabel: 'Make a setup code', noLabel: 'Go back', safeDefault: true }).then((yes) => {
                        if (yes) newCode.mutate(l);
                      });
                    }}
                  >
                    <KeyRound className="mr-1 h-4 w-4" /> Setup code
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(l)}>
                    <Pencil className="mr-1 h-4 w-4" /> Change
                  </Button>
                  {l.signedInPhones > 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={signOut.isPending}
                      onClick={() => {
                        void askConfirm(SIGN_OUT_QUESTION(l.displayName), { yesLabel: 'Sign out', noLabel: 'Go back', safeDefault: true }).then((yes) => {
                          if (yes) signOut.mutate(l);
                        });
                      }}
                    >
                      <LogOut className="mr-1 h-4 w-4" /> Sign out
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      void askConfirm(REMOVE_QUESTION(l.displayName), { yesLabel: 'Remove', noLabel: 'Go back', safeDefault: true }).then((yes) => {
                        if (yes) remove.mutate(l);
                      });
                    }}
                  >
                    <Trash2 className="mr-1 h-4 w-4" /> Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <PersonDialog
          person={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onAdded={(m) => {
            setList(m.logins);
            setEditing(null);
            setMade(m);
          }}
          onChanged={(logins) => {
            setList(logins);
            setEditing(null);
            toast({ title: 'Saved', variant: 'success' });
          }}
        />
      )}
      {made && <CodeOnceDialog made={made} url={status?.dashboardUrl ?? null} onClose={() => setMade(null)} />}
    </Card>
  );
}

/** Add a person, or change one: name, (username when new), owner or manager, and a manager's reports. */
function PersonDialog({
  person,
  onClose,
  onAdded,
  onChanged,
}: {
  person: DashLoginView | null;
  onClose: () => void;
  onAdded: (m: DashLoginMade & { displayName: string }) => void;
  onChanged: (logins: DashLoginView[]) => void;
}) {
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState(person?.displayName ?? '');
  const [username, setUsername] = useState(person?.username ?? '');
  const [role, setRole] = useState<DashRole>(person?.role ?? 'manager');
  const [seesReports, setSeesReports] = useState(person?.role === 'manager' ? person.seesReports : false);
  const save = useMutation({
    mutationFn: async () => {
      if (person) return { kind: 'changed' as const, logins: await ipc.dashboard.updateLogin({ id: person.id, displayName, role, seesReports }) };
      return { kind: 'added' as const, made: await ipc.dashboard.addLogin({ username, displayName, role, seesReports }) };
    },
    gcTime: 0,
    onSuccess: (r) => (r.kind === 'added' ? onAdded({ ...r.made, displayName: displayName.trim() }) : onChanged(r.logins)),
    onError: (e) => toast({ title: person ? 'Not saved' : 'Not added', description: said(e), variant: 'error' }),
  });
  return (
    <Dialog.Root open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">{person ? `Change ${person.displayName}` : 'Add a person'}</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-stone-600 dark:text-stone-300">
                {person ? 'Their password stays as it is.' : 'They get a one-time setup code and pick their own password on their phone.'}
              </Dialog.Description>
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </header>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label className="block text-sm font-medium">
              Their name
              <input
                value={displayName}
                maxLength={DASH_DISPLAY_NAME_MAX}
                onChange={(e) => setDisplayName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base dark:border-stone-700 dark:bg-stone-800"
                autoFocus
              />
            </label>
            {!person && (
              <label className="block text-sm font-medium">
                Username (they type it to sign in)
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
                  placeholder="for example ali"
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-base dark:border-stone-700 dark:bg-stone-800"
                />
                <span className="mt-1 block text-xs font-normal text-stone-500">3–32 letters or numbers; dots, dashes and underscores too. No spaces.</span>
              </label>
            )}
            <fieldset>
              <legend className="text-sm font-medium">What they can see</legend>
              <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(['owner', 'manager'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={cn(
                      'rounded-xl border p-3 text-left text-sm',
                      role === r ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40' : 'border-stone-300 dark:border-stone-700',
                    )}
                    aria-pressed={role === r}
                  >
                    <span className="block font-semibold">{r === 'owner' ? 'Owner' : 'Manager'}</span>
                    <span className="text-xs text-stone-600 dark:text-stone-400">
                      {r === 'owner' ? 'Everything: sales, profit, past shifts, the drawer log.' : 'Orders, the shift open now, stock and the menu.'}
                    </span>
                  </button>
                ))}
              </div>
              {role === 'manager' && (
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-amber-500" checked={seesReports} onChange={(e) => setSeesReports(e.target.checked)} />
                  <span>
                    Also sales reports and past shifts (with their cash in and out)
                    <span className="block text-xs text-stone-500">Profit and the drawer log stay the owner’s.</span>
                  </span>
                </label>
              )}
            </fieldset>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>
                Go back
              </Button>
              <Button type="submit" disabled={save.isPending || displayName.trim() === '' || (!person && username.trim().length < 3)}>
                {save.isPending ? 'One moment…' : person ? 'Save' : 'Add and make a setup code'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The setup code, shown once, with everything the person needs. Closing
 * forgets it, so it closes only with its own buttons (never Esc or a tap
 * beside it): a lost code means making another.
 */
function CodeOnceDialog({ made, url, onClose }: { made: DashLoginMade & { displayName: string }; url: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const message = setupMessage({ displayName: made.displayName, username: made.username, code: made.code, url });
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          {...KEY_DIALOG_STAYS_OPEN}
          className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900"
        >
          <Dialog.Title className="text-lg font-semibold">Setup code for {made.displayName}</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-sm text-stone-600 dark:text-stone-300">
            Shown once. Copy it and send it to them now (for example on WhatsApp). It works once, for {CODE_DAYS} days.
          </Dialog.Description>
          <p className="mt-4 select-all rounded-xl bg-stone-100 px-4 py-3 text-center font-mono text-3xl font-bold tracking-[0.18em] dark:bg-stone-800" aria-label="The setup code">
            {made.code}
          </p>
          <p className="mt-2 text-center text-sm text-stone-600 dark:text-stone-300">
            Username: <span className="font-mono font-semibold">{made.username}</span>
          </p>
          <pre className="mt-4 whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-700 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-200">
            {message}
          </pre>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(message)
                  .then(() => toast({ title: 'Copied', description: 'Paste it in a message to them now.', variant: 'success' }))
                  .catch(() => toast({ title: 'Could not copy', description: 'Write the code down by hand.', variant: 'warning' }));
              }}
            >
              <Copy className="mr-1 h-4 w-4" /> Copy the message
            </Button>
            <Button onClick={onClose}>Done — I have sent it</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
