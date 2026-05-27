import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { ToastProvider } from './components/toast/ToastProvider';
import { ipc } from './ipc/client';
import { OnboardingPage } from './features/onboarding/OnboardingPage';
import { UpdateBanner } from './features/shell/UpdateBanner';
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
    },
  },
});

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
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RootGate />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
