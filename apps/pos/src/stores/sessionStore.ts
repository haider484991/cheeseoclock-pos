import { create } from 'zustand';
import type { AuthenticatedUser, Capability } from '@cheeseoclock/shared-types';
import { hasCapability } from '@cheeseoclock/shared-types';
import { ipc, IpcError, SESSION_ENDED_EVENT } from '../ipc/client';

interface SessionState {
  user: AuthenticatedUser | null;
  status: 'idle' | 'loading' | 'authenticated' | 'error';
  errorMessage: string | null;
  login: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (capability: Capability) => boolean;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  user: null,
  status: 'idle',
  errorMessage: null,

  async login(pin: string) {
    set({ status: 'loading', errorMessage: null });
    try {
      const user = await ipc.auth.login(pin);
      set({ user, status: 'authenticated', errorMessage: null });
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
      set({ user: null, status: 'idle', errorMessage: null });
    }
  },

  async refresh() {
    try {
      const user = await ipc.auth.currentSession();
      set({ user, status: user ? 'authenticated' : 'idle', errorMessage: null });
    } catch {
      set({ user: null, status: 'idle' });
    }
  },

  can(capability: Capability) {
    const u = get().user;
    return u ? hasCapability(u.role, capability) : false;
  },
}));

// The till ended the login (idle owner/manager, 12 h cap, user switched off):
// any call that comes back "not logged in" drops the screen to the PIN pad.
if (typeof window !== 'undefined') {
  window.addEventListener(SESSION_ENDED_EVENT, () => {
    if (useSessionStore.getState().user) useSessionStore.setState({ user: null, status: 'idle' });
  });
}
