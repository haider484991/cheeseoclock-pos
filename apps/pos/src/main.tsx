import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { ToastProvider } from './components/toast/ToastProvider';
import { ConfirmHost } from './components/confirm/ConfirmHost';
import { ipc } from './ipc/client';
import { OnboardingPage } from './features/onboarding/OnboardingPage';
import { UpdateBanner } from './features/shell/UpdateBanner';
import { OrderAlerts } from './features/notifications/OrderAlerts';
import './styles/globals.css';

// Renderer-side Sentry — captures React errors + unhandled rejections in the
// renderer process. Shares context with the main-process Sentry via the
// @sentry/electron bridge. No-ops unless VITE_SENTRY_DSN is set at build time.
const RENDERER_DSN = import.meta.env['VITE_SENTRY_DSN'];
if (RENDERER_DSN) {
  void import('@sentry/electron/renderer').then((Sentry) => {
    Sentry.init({
      dsn: RENDERER_DSN,
      tracesSampleRate: 0.05,
      sendDefaultPii: false,
    });
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      // Every query and mutation here is an IPC call to this PC's own
      // database, not a network request. React Query's default ('online')
      // pauses them all whenever Windows reports the network gone: when the
      // shop Wi-Fi dropped, the board's buttons, dialogs and lists sat on
      // "loading" until it came back. And when it came back, every query
      // refetched at once.
      networkMode: 'always',
      refetchOnReconnect: false,
    },
    mutations: {
      networkMode: 'always',
    },
  },
});
// The menu only changes when someone edits or imports it, and every one of
// those screens invalidates ['menu']. Kept fresh for 5 minutes, flipping
// categories at the till (and reopening an item's choices) is served from
// memory instead of a round trip for the whole category each time.
queryClient.setQueryDefaults(['menu'], { staleTime: 5 * 60_000 });

/**
 * Gate the router on whether the device has finished onboarding. If no user
 * exists, the OnboardingPage takes over. On completion, the setupStatus query
 * is invalidated and the router mounts.
 */
function RootGate() {
  const qc = useQueryClient();
  const setupQ = useQuery({
    queryKey: ['system', 'setupStatus'],
    queryFn: () => ipc.system.getSetupStatus(),
  });

  if (setupQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-stone-500">Loading…</div>
      </div>
    );
  }

  // UpdateBanner is rendered at the root (not inside AppShell) so it surfaces
  // on every screen — login, onboarding, and the authenticated app alike.
  // The banner queries the cached state on mount, so it shows up even if the
  // updater fired its broadcast before the renderer mounted.
  return (
    <>
      {!setupQ.data?.completed ? (
        <OnboardingPage
          onComplete={() => {
            void qc.invalidateQueries({ queryKey: ['system', 'setupStatus'] });
          }}
        />
      ) : (
        <RouterProvider router={router} />
      )}
      <UpdateBanner />
      {/* Here, not in AppShell: a website order rings on the PIN screen too. */}
      {setupQ.data?.completed && <OrderAlerts />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RootGate />
        <ConfirmHost />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
