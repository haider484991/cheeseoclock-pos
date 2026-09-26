import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { User, Role, SecretKind } from '@cheeseoclock/shared-types';
import { normalizeSecret } from '@cheeseoclock/shared-schemas/sign-in-secret';
import {
  Plus,
  Edit,
  X,
  KeyRound,
  UserX,
  UserCheck,
  Shield,
  UserCog,
  ShieldCheck,
  Grid3x3,
  Keyboard,
  AlertTriangle,
} from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { SecretFields } from '../../components/secret/SecretFields';
import { secretFieldsReady } from '../../components/secret/secretRules';
import {
  FilterChips,
  Pagination,
  SearchBox,
  compareText,
  useListQuery,
  type ChipOption,
} from '../../components/list';

const ROLES: Array<{ id: Role; label: string; icon: typeof Shield; description: string }> = [
  {
    id: 'admin',
    label: 'Admin',
    icon: ShieldCheck,
    description: 'Everything — user management, settings, reports.',
  },
  {
    id: 'manager',
    label: 'Manager',
    icon: Shield,
    description: 'Menu, inventory, reports, void/discount approvals.',
  },
  {
    id: 'cashier',
    label: 'Cashier',
    icon: UserCog,
    description: 'Take orders + tender. No menu/settings edits.',
  },
];

const ROLE_BADGE: Record<Role, string> = {
  admin: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  manager: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  cashier: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200',
};

type RoleFilter = 'all' | Role;
type StatusFilter = 'all' | 'active' | 'inactive';

const ROLE_ORDER: Record<Role, number> = { admin: 0, manager: 1, cashier: 2 };

const whenFmt = new Intl.DateTimeFormat('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function when(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : whenFmt.format(d);
}

export function UsersPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const me = useSessionStore((s) => s.user);
  const [editing, setEditing] = useState<User | null | 'new'>(null);
  const [role, setRole] = useState<RoleFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  const q = useQuery({ queryKey: ['users', 'list'], queryFn: () => ipc.users.list() });

  // Switching someone off keeps them on this list (greyed, with "Switch on").
  // It used to go through users:deactivate, which also soft-deletes the row:
  // the person vanished from the screen and could never be switched back on.
  const setActiveMut = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => ipc.users.update(v),
    onSuccess: (u) => {
      toast({
        title: u.isActive ? `${u.fullName} can log in again` : `${u.fullName} can no longer log in`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const filter = useCallback(
    (u: User) =>
      (role === 'all' || u.role === role) &&
      (status === 'all' || (status === 'active' ? u.isActive : !u.isActive)),
    [role, status],
  );
  const sort = useCallback(
    (a: User, b: User) =>
      Number(b.isActive) - Number(a.isActive) ||
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      compareText(a.fullName, b.fullName),
    [],
  );
  const list = useListQuery({
    items: q.data,
    searchText: (u) => `${u.fullName} ${u.role}`,
    filter,
    sort,
    persistKey: 'users',
    defaultPageSize: 25,
    resetPageOn: [role, status],
  });

  const roleOptions: ChipOption<RoleFilter>[] = useMemo(() => {
    const inStatus = list.searched.filter((u) => status === 'all' || (status === 'active' ? u.isActive : !u.isActive));
    return [
      { id: 'all', label: 'Everyone', count: inStatus.length },
      ...ROLES.map((r) => ({ id: r.id as RoleFilter, label: `${r.label}s`, count: inStatus.filter((u) => u.role === r.id).length })),
    ];
  }, [list.searched, status]);
  const statusOptions: ChipOption<StatusFilter>[] = useMemo(() => {
    const inRole = list.searched.filter((u) => role === 'all' || u.role === role);
    return [
      { id: 'all', label: 'Any status' },
      { id: 'active', label: 'Can log in', count: inRole.filter((u) => u.isActive).length, tone: 'green' },
      { id: 'inactive', label: 'Switched off', count: inRole.filter((u) => !u.isActive).length },
    ];
  }, [list.searched, role]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="mt-1 text-stone-600 dark:text-stone-400">
            Everyone who logs in to the till, with a number PIN or a password. The role decides what they
            can see and change.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </header>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchBox value={list.query} onChange={list.setQuery} placeholder="Search by name…" label="Search users" />
          <FilterChips label="Role" options={roleOptions} value={role} onChange={setRole} />
        </div>
        <FilterChips label="Status" options={statusOptions} value={status} onChange={setStatus} className="mb-3" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
              <tr>
                <th className="pb-2">Name</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Signs in with</th>
                <th className="pb-2">Last login</th>
                <th className="pb-2 text-right">Added</th>
                <th className="pb-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <tr key={u.id} className={cn('border-t border-stone-100 dark:border-stone-800', !u.isActive && 'text-stone-400')}>
                    <td className="py-2">
                      <div className="font-medium">
                        {u.fullName}
                        {isMe && (
                          <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                            you
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2">
                      <span className={cn('rounded px-2 py-0.5 text-xs capitalize', ROLE_BADGE[u.role])}>{u.role}</span>
                    </td>
                    <td className="py-2">
                      {u.isActive ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                          <UserCheck className="h-3 w-3" /> Can log in
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                          <UserX className="h-3 w-3" /> Switched off
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <SignInBadge kind={u.secretKind} />
                    </td>
                    <td className="py-2 text-xs text-stone-500">{when(u.lastLoginAt)}</td>
                    <td className="py-2 text-right text-xs text-stone-500">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(u)}
                          className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                          aria-label={`Edit ${u.fullName}`}
                          title="Edit name, role, PIN or password"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        {u.isActive ? (
                          <button
                            type="button"
                            disabled={isMe || setActiveMut.isPending}
                            onClick={() => {
                              void askConfirm(
                                `Deactivate "${u.fullName}"? Their PIN or password stops working straight away. You can switch them back on here later.`,
                              ).then((ok) => {
                                if (ok) setActiveMut.mutate({ id: u.id, isActive: false });
                              });
                            }}
                            className="rounded p-1 text-red-500 hover:bg-red-50 disabled:opacity-30 dark:hover:bg-red-950"
                            aria-label={`Switch off ${u.fullName}`}
                            title={isMe ? "You can't switch yourself off" : 'Switch off (PIN or password stops working)'}
                          >
                            <UserX className="h-4 w-4" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={setActiveMut.isPending}
                            onClick={() => setActiveMut.mutate({ id: u.id, isActive: true })}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950"
                            title="Switch back on"
                          >
                            <UserCheck className="h-4 w-4" /> Switch on
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {list.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-stone-500">
                    {q.isLoading ? 'Loading…' : (q.data?.length ?? 0) === 0 ? 'No users yet.' : 'No users match.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={list.page}
          pageCount={list.pageCount}
          total={list.total}
          from={list.from}
          to={list.to}
          onPage={list.setPage}
          pageSize={list.pageSize}
          onPageSize={list.setPageSize}
          noun="users"
        />
      </Card>

      {editing && (
        <UserDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          isMe={editing !== 'new' && editing.id === me?.id}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function UserDialog({ existing, isMe, onClose }: { existing: User | null; isMe: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [fullName, setFullName] = useState(existing?.fullName ?? '');
  const [role, setRole] = useState<Role>(existing?.role ?? 'cashier');
  const [kind, setKind] = useState<SecretKind>(existing?.secretKind ?? 'pin');
  const [secret, setSecret] = useState('');
  const [confirmSecret, setConfirmSecret] = useState('');
  // Someone made on the other till has nothing to sign in with here yet:
  // setting one is the point of opening them.
  const notSetHere = existing !== null && existing.secretKind === null;
  const [showSecretSection, setShowSecretSection] = useState(!existing || notSetHere);

  const mut = useMutation({
    mutationFn: () => {
      if (existing) {
        return ipc.users.update({
          id: existing.id,
          fullName: fullName.trim(),
          role,
          ...(showSecretSection && secret.trim() ? { pin: normalizeSecret(secret) } : {}),
        });
      }
      return ipc.users.create({ fullName: fullName.trim(), role, pin: normalizeSecret(secret) });
    },
    onSuccess: () => {
      toast({
        title: existing ? 'User updated' : `User "${fullName.trim()}" created`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) =>
      // The till's own words: "That password is already used by someone else".
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const secretOk = secretFieldsReady(kind, secret, confirmSecret);
  // Someone from the other till can still be renamed or moved to another
  // role with the boxes left empty.
  const secretLeftEmpty = secret.trim() === '' && confirmSecret.trim() === '';
  const canSubmit =
    fullName.trim().length > 0 &&
    (existing ? !showSecretSection || secretOk || (notSetHere && secretLeftEmpty) : secretOk);

  async function save() {
    if (!canSubmit || mut.isPending) return;
    // Taking away your own admin role locks you out of this screen.
    if (isMe && existing?.role === 'admin' && role !== 'admin') {
      const ok = await askConfirm(
        `Change your own role to ${role}? You will lose access to Users and Settings as soon as you save. Another admin will have to give it back.`,
      );
      if (!ok) return;
    }
    mut.mutate();
  }

  const fields = (
    <SecretFields
      kind={kind}
      onKind={setKind}
      secret={secret}
      onSecret={setSecret}
      confirm={confirmSecret}
      onConfirm={setConfirmSecret}
      idPrefix="user"
      who={isMe ? 'you' : 'they'}
    />
  );

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[520px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between p-5 pb-3">
            <Dialog.Title className="text-lg font-bold">
              {existing ? `Edit ${existing.fullName}` : 'Add user'}
            </Dialog.Title>
            <Dialog.Description className="sr-only">Name, role and sign-in.</Dialog.Description>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="flex-1 space-y-4 overflow-y-auto px-5">
              <div>
                <label htmlFor="user-full-name" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                  Full name
                </label>
                <input
                  id="user-full-name"
                  type="text"
                  value={fullName}
                  autoFocus
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </div>

              <div>
                <div className="mb-2 block text-xs uppercase tracking-wider text-stone-500">Role</div>
                <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label="Role">
                  {ROLES.map((r) => {
                    const RoleIcon = r.icon;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        role="radio"
                        aria-checked={role === r.id}
                        onClick={() => setRole(r.id)}
                        className={cn(
                          'flex items-start gap-3 rounded-lg border-2 p-3 text-left transition-colors',
                          role === r.id
                            ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                            : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                        )}
                      >
                        <RoleIcon className="mt-0.5 h-4 w-4" />
                        <div className="flex-1">
                          <div className="text-sm font-semibold">{r.label}</div>
                          <div className="text-xs text-stone-500">{r.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {existing ? (
                <div className="border-t border-stone-200 pt-3 dark:border-stone-700">
                  {notSetHere ? (
                    <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>
                        {existing.fullName} was added on the other till. PINs and passwords never travel between
                        tills, so set one for this till.
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setShowSecretSection((s) => !s);
                        setSecret('');
                        setConfirmSecret('');
                      }}
                      className="mb-2 inline-flex items-center gap-1 text-sm text-amber-700 hover:underline dark:text-amber-300"
                    >
                      <KeyRound className="h-3 w-3" />
                      {showSecretSection ? 'Keep the current PIN or password' : 'Change PIN or password'}
                    </button>
                  )}
                  {showSecretSection && fields}
                </div>
              ) : (
                fields
              )}

              {showSecretSection && isMe && (
                <p className="text-xs text-stone-500">
                  Write it down somewhere safe — there is no &quot;forgot password&quot; yet.
                </p>
              )}
            </div>

            <footer className="mt-4 flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-700">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!canSubmit || mut.isPending}>
                {mut.isPending ? 'Saving…' : existing ? 'Save changes' : 'Create user'}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** How someone signs in on this till: a PIN, a password, or nothing yet (made on the other till). */
function SignInBadge({ kind }: { kind: SecretKind | null }) {
  if (kind === null) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        title="Added on the other till. Edit them to set a PIN or password for this till."
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Not set here — set one
      </span>
    );
  }
  const Icon = kind === 'pin' ? Grid3x3 : Keyboard;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-700 dark:bg-stone-800 dark:text-stone-200">
      <Icon className="h-3 w-3" aria-hidden="true" /> {kind === 'pin' ? 'PIN' : 'Password'}
    </span>
  );
}
