/**
 * The Riders page in the words of Send out (v0.7.34; owner, 2 Oct 2026:
 * every rider on the list is the shop's own staff). The list is for Assign
 * rider; a rider from a delivery service is never added, Send out on Live
 * Orders handles him. Rendered to static markup (react-dom/server, no
 * browser; nothing calls the till). Every name and number is made up.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { Rider, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { RidersPage } from './RidersPage';

function rider(n: number, isActive: boolean): Rider {
  return {
    id: `rider-${n}` as UUID,
    name: `Test Rider ${n}`,
    phone: `0300 000000${n}`,
    isActive,
    notes: null,
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T09:00:00.000Z',
  };
}

/** The Riders page with this list as riders:list answers it. */
function render(riders: Rider[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['riders', 'all'], riders);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RidersPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const SUBTITLE =
  "Your own delivery staff, for Assign rider. Riders from a delivery service don't need adding — use Send out on Live Orders.";

describe('Riders: your own delivery staff, outside riders use Send out', () => {
  it('the subtitle says the list is the shop’s own riders, with the count after it', () => {
    const words = text(render([rider(1, true), rider(2, true), rider(3, false)]));
    expect(words).toContain(`Riders ${SUBTITLE} 2 active · 1 switched off.`);
    expect(words).toContain('Test Rider 1');
    expect(words).not.toContain('Delivery staff who can be assigned to orders');
  });

  it('every rider on: the count alone after the words', () => {
    expect(text(render([rider(1, true)]))).toContain(`${SUBTITLE} 1 active.`);
  });

  it('no riders yet: add your own staff here, outside riders need nothing', () => {
    const words = text(render([]));
    expect(words).toContain(`${SUBTITLE} 0 active.`);
    expect(words).toContain('No riders yet. Add your own delivery staff here. Outside riders need nothing — use Send out.');
    expect(words).not.toContain('Add your first delivery person');
  });
});
