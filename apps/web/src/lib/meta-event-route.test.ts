/**
 * POST /api/meta/event: the landing popup's LocationConfirmed, relayed to Meta's Conversions API
 * only for an area the owner delivers to now, and only so often from one address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteFacts } from './delivery-facts';

vi.mock('@/lib/site-facts', () => ({
  getSiteFacts: async (): Promise<Pick<SiteFacts, 'zones'>> => ({
    zones: [
      { id: 'dha-6', name: 'DHA Phase 6', shortName: 'Phase 6', group: 'DHA', feeCents: 20_000, feeItemId: null, active: true },
      { id: 'creek-vista', name: 'Creek Vista (DHA)', shortName: 'Creek Vista', group: 'DHA', feeCents: 25_000, feeItemId: null, active: false },
    ] as unknown as SiteFacts['zones'],
  }),
}));

const { POST } = await import('@/app/api/meta/event/route');

const EID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99';
let ip = 0;
const sent: Array<{ data: Array<{ event_name: string; custom_data: Record<string, unknown> }> }> = [];

function post(body: unknown, fromIp: string = `10.1.0.${++ip}`) {
  return POST(
    new Request('https://site.test/api/meta/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': fromIp },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_META_PIXEL_ID'] = '1794891064972562';
  process.env['META_CAPI_ACCESS_TOKEN'] = 'EAAtestTOKEN0123456789abcdefABCDEF';
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
  });
});

afterEach(() => {
  delete process.env['NEXT_PUBLIC_META_PIXEL_ID'];
  delete process.env['META_CAPI_ACCESS_TOKEN'];
  vi.unstubAllGlobals();
});

describe('POST /api/meta/event', () => {
  it('relays a delivery to an open area, with its name, and a pick-up', async () => {
    expect((await post({ event: 'LocationConfirmed', eventId: EID, fulfilment: 'delivery', zoneId: 'dha-6' })).status).toBe(204);
    expect((await post({ event: 'LocationConfirmed', eventId: EID, fulfilment: 'pickup' })).status).toBe(204);
    expect(sent.map((b) => b.data[0]!.custom_data['content_name'])).toEqual(['DHA Phase 6', 'Pick-up']);
    expect(sent[0]!.data[0]!.event_name).toBe('LocationConfirmed');
  });

  it('sends nothing for a paused or unknown area, another event, a bad id or a broken body — and still answers 204', async () => {
    for (const body of [
      { event: 'LocationConfirmed', eventId: EID, fulfilment: 'delivery', zoneId: 'creek-vista' },
      { event: 'LocationConfirmed', eventId: EID, fulfilment: 'delivery', zoneId: 'saddar' },
      { event: 'LocationConfirmed', eventId: EID, fulfilment: 'delivery' },
      { event: 'Purchase', eventId: EID, fulfilment: 'pickup' },
      { event: 'LocationConfirmed', eventId: 'x', fulfilment: 'pickup' },
      '{not json',
    ]) {
      expect((await post(body)).status).toBe(204);
    }
    expect(sent).toHaveLength(0);
  });

  it('cuts off a burst from one address', async () => {
    for (let i = 0; i < 15; i++) await post({ event: 'LocationConfirmed', eventId: EID, fulfilment: 'pickup' }, '10.9.9.9');
    expect(sent).toHaveLength(12);
  });

  it('sends nothing without the token', async () => {
    delete process.env['META_CAPI_ACCESS_TOKEN'];
    await post({ event: 'LocationConfirmed', eventId: EID, fulfilment: 'pickup' });
    expect(sent).toHaveLength(0);
  });
});
