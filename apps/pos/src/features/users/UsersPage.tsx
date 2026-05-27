import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { User, Role } from '@cheeseoclock/shared-types';
import { Plus, Edit, X, KeyRound, UserX, UserCheck, Shield, UserCog, ShieldCheck } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';

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

export function UsersPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const me = useSessionStore((s) => s.user);
  const [editing, setEditing] = useState<User | null | 'new'>(null);

  const q = useQuery({ queryKey: ['users', 'list'], queryFn: () => ipc.users.list() });

  const deactivateMut = useMutation({
    mutationFn: (id: string) => ipc.users.deactivate(id),
    onSuccess: () => {
      toast({ title: 'User deactivated', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const activateMut = useMutation({
    mutationFn: (id: string) => ipc.users.update({ id, isActive: true }),
    onSuccess: () => {
      toast({ title: 'User reactivated', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="mt-1 text-stone-600 dark:text-stone-400">
            PIN-based logins. Roles control what's visible + writable.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </header>

      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <th className="pb-2">Name</th>
              <th className="pb-2">Role</th>
              <th className="pb-2">Status</th>
              <th className="pb-2 text-right">Created</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((u) => {
              const isMe = u.id === me?.id;
              return (
                <tr key={u.id} className="border-t border-stone-100 dark:border-stone-800">
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
                    <span
                      className={cn(
                        'rounded px-2 py-0.5 text-xs capitalize',
                        ROLE_BADGE[u.role],
                      )}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="py-2">
                    {u.isActive ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                        <UserCheck className="h-3 w-3" /> Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                        <UserX className="h-3 w-3" /> Inactive
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right text-xs text-stone-500">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => setEditing(u)}
                      className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                      aria-label="Edit"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    {u.isActive ? (
                      <button
                        disabled={isMe}
                        onClick={() => {
                          if (
                            confirm(
                              `Deactivate "${u.fullName}"? They can be reactivated later.`,
                            )
                          )
                            deactivateMut.mutate(u.id);
                        }}
                        className="rounded p-1 text-red-500 hover:bg-red-50 disabled:opacity-30 dark:hover:bg-red-950"
                        aria-label="Deactivate"
                        title={isMe ? "Can't deactivate yourself" : 'Deactivate'}
                      >
                        <UserX className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => activateMut.mutate(u.id)}
                        className="rounded p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950"
                        aria-label="Reactivate"
                      >
                        <UserCheck className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {(!q.data || q.data.length === 0) && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-stone-500">
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {editing && (
        <UserDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function UserDialog({ existing, onClose }: { existing: User | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [fullName, setFullName] = useState(existing?.fullName ?? '');
  const [role, setRole] = useState<Role>(existing?.role ?? 'cashier');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPinSection, setShowPinSection] = useState(!existing);

  const mut = useMutation({
    mutationFn: () => {
      if (existing) {
        return ipc.users.update({
          id: existing.id,
          fullName,
          role,
          ...(showPinSection && pin ? { pin } : {}),
        });
      }
      return ipc.users.create({ fullName, role, pin });
    },
    onSuccess: () => {
      toast({
        title: existing ? 'User updated' : `User "${fullName}" created`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const pinValid =
    pin.length >= 4 &&
    pin.length <= 8 &&
    /^\d+$/.test(pin) &&
    (!showPinSection || pin === confirmPin);
  const canSubmit =
    fullName.trim().length > 0 &&
    (existing ? (!showPinSection || pinValid) : pinValid);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? `Edit ${existing.fullName}` : 'Add user'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                Full name
              </label>
              <input
                type="text"
                value={fullName}
                autoFocus
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>

            <div>
              <label className="mb-2 block text-xs uppercase tracking-wider text-stone-500">
                Role
              </label>
              <div className="grid grid-cols-1 gap-2">
                {ROLES.map((r) => {
                  const RoleIcon = r.icon;
                  return (
                    <button
                      key={r.id}
                      type="button"
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
                <button
                  type="button"
                  onClick={() => setShowPinSection((s) => !s)}
                  className="inline-flex items-center gap-1 text-sm text-amber-700 hover:underline dark:text-amber-300"
                >
                  <KeyRound className="h-3 w-3" />
                  {showPinSection ? 'Cancel PIN reset' : 'Reset PIN'}
                </button>
                {showPinSection && (
                  <PinFields
                    pin={pin}
                    confirmPin={confirmPin}
                    onPin={setPin}
                    onConfirm={setConfirmPin}
                  />
                )}
              </div>
            ) : (
              <PinFields
                pin={pin}
                confirmPin={confirmPin}
                onPin={setPin}
                onConfirm={setConfirmPin}
              />
            )}
          </div>

          <footer className="mt-5 flex justify-end gap-2 border-t border-stone-200 pt-4 dark:border-stone-700">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!canSubmit || mut.isPending} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : existing ? 'Save changes' : 'Create user'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PinFields({
  pin,
  confirmPin,
  onPin,
  onConfirm,
}: {
  pin: string;
  confirmPin: string;
  onPin: (v: string) => void;
  onConfirm: (v: string) => void;
}) {
  const mismatch = pin.length > 0 && confirmPin.length > 0 && pin !== confirmPin;
  const tooShort = pin.length > 0 && pin.length < 4;
  return (
    <div className="mt-2 space-y-2">
      <div>
        <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
          PIN (4–8 digits)
        </label>
        <input
          type="password"
          value={pin}
          onChange={(e) => onPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          inputMode="numeric"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono tracking-widest dark:border-stone-700 dark:bg-stone-800"
        />
        {tooShort && (
          <div className="mt-1 text-xs text-red-500">At least 4 digits</div>
        )}
      </div>
      <div>
        <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
          Confirm PIN
        </label>
        <input
          type="password"
          value={confirmPin}
          onChange={(e) => onConfirm(e.target.value.replace(/\D/g, '').slice(0, 8))}
          inputMode="numeric"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono tracking-widest dark:border-stone-700 dark:bg-stone-800"
        />
        {mismatch && <div className="mt-1 text-xs text-red-500">PINs don't match</div>}
      </div>
    </div>
  );
}
