import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CAPI_TIMEOUT_MS,
  GRAPH_VERSION,
  purchaseEvent,
  readCapiConfig,
  requestFacts,
  sendCapiEvents,
  sendServerPurchase,
  type CapiConfig,
  type ServerPurchase,
} from './meta-capi';

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const PIXEL = '1794891064972562';
const TOKEN = 'EAAtestTOKEN0123456789abcdefABCDEF';
const CONFIG: CapiConfig = { pixelId: PIXEL, accessToken: TOKEN };
const ORDER_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = Date.UTC(2026, 9, 24, 15, 0, 0);

const ORDER: ServerPurchase = {
  orderId: ORDER_ID,
  totalCents: 506_000,
  lines: [
    { id: 'item-fajita-l', quantity: 2, unitCents: 220_000 },
    { id: 'item-mega', quantity: 1, unitCents: 480_000 },
  ],
  customer: { phone: '+923001234567', name: 'Ahmed Khan' },
};

function request(headers: Record<string, string> = {}) {
  return new Request('https://www.cheeseoclock.net/api/orders', { method: 'POST', headers });
}

/** A fetch that answers as Meta does and keeps what it was sent. */
function meta(answer: { status?: number; body?: unknown } = {}) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(answer.body ?? { events_received: 1, fbtrace_id: 'x' }), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe('readCapiConfig: on only with a pixel id and a token', () => {
  it('reads both', () => {
    expect(readCapiConfig({ NEXT_PUBLIC_META_PIXEL_ID: PIXEL, META_CAPI_ACCESS_TOKEN: ` ${TOKEN}\n` })).toEqual(CONFIG);
  });

  it('is off when either is missing or not one', () => {
    expect(readCapiConfig({ NEXT_PUBLIC_META_PIXEL_ID: PIXEL })).toBeNull();
    expect(readCapiConfig({ META_CAPI_ACCESS_TOKEN: TOKEN })).toBeNull();
    expect(readCapiConfig({ NEXT_PUBLIC_META_PIXEL_ID: 'abc', META_CAPI_ACCESS_TOKEN: TOKEN })).toBeNull();
    expect(readCapiConfig({ NEXT_PUBLIC_META_PIXEL_ID: PIXEL, META_CAPI_ACCESS_TOKEN: 'short' })).toBeNull();
    expect(readCapiConfig({ NEXT_PUBLIC_META_PIXEL_ID: PIXEL, META_CAPI_ACCESS_TOKEN: 'has spaces in it 1234567890' })).toBeNull();
  });
});

describe('requestFacts', () => {
  it('reads the IP, the browser, the Pixel cookies and the page', () => {
    const facts = requestFacts(
      request({
        'x-forwarded-for': '39.45.1.2, 10.0.0.1',
        'user-agent': 'Mozilla/5.0 (Linux; Android 14)',
        cookie: 'a=1; _fbp=fb.1.1761300000000.123456789; _fbc=fb.1.1761300000000.IwAR0abcdefghij',
        referer: 'https://www.cheeseoclock.net/menu?utm_source=facebook&fbclid=IwAR0zzzzzzzzzz',
      }),
      NOW,
    );
    expect(facts).toEqual({
      ip: '39.45.1.2',
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      fbp: 'fb.1.1761300000000.123456789',
      fbc: 'fb.1.1761300000000.IwAR0abcdefghij',
      sourceUrl: 'https://www.cheeseoclock.net/menu',
    });
  });

  it('makes the click cookie from the page’s fbclid when the Pixel set none', () => {
    const facts = requestFacts(request({ referer: 'https://www.cheeseoclock.net/menu?fbclid=IwAR0abcdefghij' }), NOW);
    expect(facts.fbc).toBe(`fb.1.${NOW}.IwAR0abcdefghij`);
  });

  it('drops cookies that are not the Pixel’s shape, and never names a tracking page', () => {
    const facts = requestFacts(
      request({
        'x-real-ip': '2400:adc1::1',
        cookie: '_fbp=hello; _fbc=fb.1.x.y',
        referer: 'https://www.cheeseoclock.net/track/abc?phone=03001234567',
      }),
      NOW,
    );
    expect(facts).toMatchObject({ ip: '2400:adc1::1', fbp: null, fbc: null, sourceUrl: 'https://www.cheeseoclock.net/menu' });
  });

  it('has a page and nothing else for a bare request', () => {
    expect(requestFacts(request(), NOW)).toEqual({
      ip: null,
      userAgent: null,
      fbp: null,
      fbc: null,
      sourceUrl: 'https://www.cheeseoclock.net/menu',
    });
  });
});

describe('purchaseEvent', () => {
  const facts = requestFacts(
    request({
      'x-forwarded-for': '39.45.1.2',
      'user-agent': 'UA',
      cookie: '_fbp=fb.1.1761300000000.123456789',
      referer: 'https://www.cheeseoclock.net/menu',
    }),
    NOW,
  );

  it('is the browser’s Purchase, with the order id as the event id, and the hashed customer', () => {
    expect(purchaseEvent(ORDER, facts, NOW)).toEqual({
      event_name: 'Purchase',
      event_time: NOW / 1000,
      event_id: ORDER_ID,
      action_source: 'website',
      event_source_url: 'https://www.cheeseoclock.net/menu',
      user_data: {
        ph: [hash('923001234567')],
        external_id: [hash('923001234567')],
        fn: [hash('ahmed')],
        ln: [hash('khan')],
        ct: [hash('karachi')],
        st: [hash('sindh')],
        country: [hash('pk')],
        client_ip_address: '39.45.1.2',
        client_user_agent: 'UA',
        fbp: 'fb.1.1761300000000.123456789',
      },
      custom_data: {
        content_ids: ['item-fajita-l', 'item-mega'],
        contents: [
          { id: 'item-fajita-l', quantity: 2 },
          { id: 'item-mega', quantity: 1 },
        ],
        num_items: 3,
        value: 5060,
        currency: 'PKR',
        content_type: 'product',
        order_id: ORDER_ID,
      },
    });
  });

  it('never carries the phone or the name in clear', () => {
    const sent = JSON.stringify(purchaseEvent(ORDER, facts, NOW));
    for (const clear of ['923001234567', '+92300', 'Ahmed', 'ahmed', 'Khan']) expect(sent).not.toContain(clear);
  });

  it('is null without a total', () => {
    expect(purchaseEvent({ ...ORDER, totalCents: Number.NaN }, facts, NOW)).toBeNull();
  });
});

describe('sendCapiEvents', () => {
  const event = purchaseEvent(ORDER, requestFacts(request(), NOW), NOW)!;

  it('posts the events and the token to the pixel’s events edge', async () => {
    const { fetchImpl, sent } = meta();
    const result = await sendCapiEvents(CONFIG, [event], { fetchImpl });
    expect(result).toEqual({ ok: true, status: 200, received: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL}/events`);
    expect(sent[0]!.body).toEqual({ data: [event], access_token: TOKEN });
  });

  it('adds a Test events code only when it is one', async () => {
    const good = meta();
    await sendCapiEvents(CONFIG, [event], { fetchImpl: good.fetchImpl, testCode: 'test12345' });
    expect(good.sent[0]!.body['test_event_code']).toBe('TEST12345');
    const bad = meta();
    await sendCapiEvents(CONFIG, [event], { fetchImpl: bad.fetchImpl, testCode: 'DROP TABLE' });
    expect(bad.sent[0]!.body).not.toHaveProperty('test_event_code');
  });

  it('reports Meta’s refusal without the token', async () => {
    const { fetchImpl } = meta({ status: 400, body: { error: { code: 190, message: 'Invalid OAuth access token.' } } });
    const result = await sendCapiEvents(CONFIG, [event], { fetchImpl });
    expect(result).toEqual({ ok: false, status: 400, error: '190: Invalid OAuth access token.' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('gives up after its wait', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ) as unknown as typeof fetch;
      const pending = sendCapiEvents(CONFIG, [event], { fetchImpl });
      await vi.advanceTimersByTimeAsync(CAPI_TIMEOUT_MS + 1);
      await expect(pending).resolves.toEqual({ ok: false, error: 'timed out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves when the network fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    await expect(sendCapiEvents(CONFIG, [event], { fetchImpl })).resolves.toEqual({
      ok: false,
      error: 'getaddrinfo ENOTFOUND',
    });
  });
});

describe('sendServerPurchase: the order route’s one call', () => {
  it('sends nothing when the Conversions API is off', async () => {
    const { fetchImpl, sent } = meta();
    await expect(sendServerPurchase(request(), ORDER, { config: null, fetchImpl })).resolves.toEqual({
      ok: false,
      error: 'off',
    });
    expect(sent).toHaveLength(0);
  });

  it('is off in this test run: no token in the environment', () => {
    expect(readCapiConfig()).toBeNull();
  });

  it('sends the order’s Purchase, with the test code it was given', async () => {
    const { fetchImpl, sent } = meta();
    const result = await sendServerPurchase(request({ 'user-agent': 'UA' }), ORDER, {
      config: CONFIG,
      fetchImpl,
      testCode: 'TEST999',
    });
    expect(result.ok).toBe(true);
    const body = sent[0]!.body as { data: Array<{ event_id: string; event_name: string }>; test_event_code: string };
    expect(body.data[0]).toMatchObject({ event_id: ORDER_ID, event_name: 'Purchase' });
    expect(body.test_event_code).toBe('TEST999');
  });

  it('never rejects, and logs a failure without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { fetchImpl } = meta({ status: 500, body: { error: { code: 1, message: 'boom' } } });
      await expect(sendServerPurchase(request(), ORDER, { config: CONFIG, fetchImpl })).resolves.toMatchObject({ ok: false });
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });
});
