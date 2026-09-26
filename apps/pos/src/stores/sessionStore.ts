import { create } from 'zustand';
import type { AuthenticatedUser, Capability } from '@cheeseoclock/shared-types';
import { hasCapability } from '@cheeseoclock/shared-types';
import { ipc, IpcError, SESSION_ENDED_EVENT, STEP_IN_HELD_EVENT } from '../ipc/client';

interface SessionState {
  user: AuthenticatedUser | null;
  status: 'idle' | 'loading' | 'authenticated' | 'error';
  errorMessage: string | null;
  /**
   * One line for the PIN pad after a login ended on its own (idle, the 12 h
   * cap, a held step-in nobody answered), so whoever comes back knows why and
   * that signing in again carries on. Cleared by the next sign-in or log-out.
   */
  endedNote: string | null;
  login: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** A stepping-in manager's own PIN: the held (or soon held) login becomes a normal one. */
  keepStepIn: (pin: string) => Promise<void>;
  can: (capability: Capability) => boolean;
}

/** What the PIN pad says when `user`'s login ended without anyone logging out. */
export function endedOnItsOwnNote(user: Pick<AuthenticatedUser, 'fullName'>): string {
  return `${user.fullName}'s login ended on its own. Sign in again to carry on.`;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  user: null,
  status: 'idle',
  errorMessage: null,
  endedNote: null,

  async login(pin: string) {
    set({ status: 'loading', errorMessage: null });
    try {
      const user = await ipc.auth.login(pin);
      set({ user, status: 'authenticated', errorMessage: null, endedNote: null });
    } catch (err) {
      const message = err instanceof IpcError ? err.message : 'Login failed';
      set({ user: null, status: 'error', errorMessage: message });
      throw err;
    }
  },

  async logout() {
    try {
      await ipc.auth.logout();
    } finally {
      set({ user: null, status: 'idle', errorMessage: null, endedNote: null });
    }
  },

  async refresh() {
    const before = get().user;
    try {
      const user = await ipc.auth.currentSession();
      set({
        user,
        status: user ? 'authenticated' : 'idle',
        errorMessage: null,
        ...(before && !user ? { endedNote: endedOnItsOwnNote(before) } : {}),
      });
    } catch {
      set({ user: null, status: 'idle' });
    }
  },

  async keepStepIn(pin: string) {
    const user = await ipc.auth.keepStepIn(pin);
    set({ user, status: 'authenticated', errorMessage: null });
  },

  can(capability: Capability) {
    const u = get().user;
    return u ? hasCapability(u.role, capability) : false;
  },
}));

// The till ended the login (idle owner/manager, 12 h cap, user switched off):
// any call that comes back "not logged in" drops the screen to the PIN pad.
// A stepping-in login that is only HELD keeps its page: the PIN box goes over
// it (StepInHold) until the same person types their PIN or hands the till back.
if (typeof window !== 'undefined') {
  window.addEventListener(SESSION_ENDED_EVENT, () => {
    const user = useSessionStore.getState().user;
    if (user) useSessionStore.setState({ user: null, status: 'idle', endedNote: endedOnItsOwnNote(user) });
  });
  window.addEventListener(STEP_IN_HELD_EVENT, () => {
    const user = useSessionStore.getState().user;
    if (user && !user.stepInHeld) useSessionStore.setState({ user: { ...user, stepInHeld: true } });
  });
}
