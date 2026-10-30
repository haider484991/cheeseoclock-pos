/**
 * The shop's WhatsApp on Meta's Cloud API (26 Oct 2026, lib/whatsapp-store): Meta's webhook calls are believed only
 * with the app secret's signature; each customer message is kept once with the ad that brought the chat, never its
 * words; and the bot answers a customer's first message of the shop's day with their personal order link — once,
 * only while switched on, and never over staff mid-conversation on the phone.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHOP_FACTS } from './shop-facts';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  open: true,
}));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
vi.mock('@/lib/site-facts', () => ({ getShopFacts: async () => DEFAULT_SHOP_FACTS }));
vi.mock('@/lib/store-status', () => ({ getStoreStatus: async () => ({ acceptingOrders: db.open }) }));

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { signatureOk, readCall, answersKind } = await import('./whatsapp-webhook');
const { autoReplyText, greetingName, orderLinkUrl } = await import('./whatsapp-send');
const { shopDayStart } = await import('./whatsapp-store');
const route = await import('@/app/api/whatsapp/webhook/route');

const SECRET = 'test-app-secret';
const PHONE_ID = '1356740797521773';
const sign = (raw: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/** A call as Meta sends one: a customer's message, from an ad or not. */
function inbound(o: { waId: string; id: string; at?: Date; type?: string; name?: string; ad?: boolean }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1881791873188347',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '923009367865', phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: o.name ?? 'Ali Raza' }, wa_id: o.waId }],
              messages: [
                {
                  from: o.waId,
                  id: o.id,
                  timestamp: String(Math.floor((o.at ?? new Date()).getTime() / 1000)),
                  type: o.type ?? 'text',
                  text: { body: 'Mega box chahiye, kitne ka hai?' },
                  ...(o.ad
                    ? {
                        referral: {
                          source_url: 'https://fb.me/abc',
                          source_id: '120251373303340193',
                          source_type: 'ad',
                          headline: 'Mega Cheese Box Rs 4,800',
                          body: '4 log, sab bhookay',
                          media_type: 'video',
                          ctwa_clid: 'ARAkLkA8',
                        },
                      }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Staff answering from the phone app: Meta's echo of it. */
function staffEcho(o: { waId: string; id: string; at?: Date }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1881791873188347',
        changes: [
          {
            field: 'smb_message_echoes',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '923009367865', phone_number_id: PHONE_ID },
              message_echoes: [
                {
                  from: '923009367865',
                  to: o.waId,
                  id: o.id,
                  timestamp: String(Math.floor((o.at ?? new Date()).getTime() / 1000)),
                  type: 'text',
                  text: { body: 'Ji, Rs 4,800' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function post(body: unknown, signature?: string | null) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature ?? sign(raw);
  return route.POST(new Request('https://site.test/api/whatsapp/webhook', { method: 'POST', headers, body: raw }));
}

/** Meta's Cloud API, as the bot's sends see it. */
const graph = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const sentTo = () => graph.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as { to: string; text: { body: string } });

beforeAll(async () => {
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  vi.stubGlobal('fetch', graph);
});

beforeEach(() => {
  process.env['META_APP_SECRET'] = SECRET;
  process.env['WHATSAPP_AUTO_REPLY'] = 'on';
  process.env['WHATSAPP_ACCESS_TOKEN'] = 'test-token';
  db.open = true;
  graph.mockReset();
  graph.mockImplementation(async () => Response.json({ messages: [{ id: `wamid.bot.${Math.random()}` }] }));
});

afterEach(() => {
  delete process.env['WHATSAPP_VERIFY_TOKEN'];
});

async function chat(waId: string) {
  return (await db.pg.query(`SELECT * FROM wa_chats WHERE wa_id = $1`, [waId])).rows[0] as Record<string, unknown> | undefined;
}
async function events(waId: string) {
  return (await db.pg.query(`SELECT direction, kind, ad_id, ad_headline, ctwa_clid FROM wa_events WHERE wa_id = $1 ORDER BY at, direction`, [waId]))
    .rows as Array<Record<string, unknown>>;
}

describe('signatureOk', () => {
  it('believes only the app secret’s signature of the exact body', () => {
    expect(signatureOk('{"a":1}', sign('{"a":1}'), SECRET)).toBe(true);
    expect(signatureOk('{"a":2}', sign('{"a":1}'), SECRET)).toBe(false);
    expect(signatureOk('{"a":1}', sign('{"a":1}', 'another-app'), SECRET)).toBe(false);
    expect(signatureOk('{"a":1}', null, SECRET)).toBe(false);
    expect(signatureOk('{"a":1}', 'sha256=zz', SECRET)).toBe(false);
    expect(signatureOk('{"a":1}', sign('{"a":1}'), undefined)).toBe(false);
  });
});

describe('readCall', () => {
  it('reads the customer, their WhatsApp name, the kind of message, the ad, and the words for the bot', () => {
    const call = readCall(inbound({ waId: '923001112233', id: 'wamid.1', ad: true }));
    expect(call.staff).toEqual([]);
    expect(call.inbound).toHaveLength(1);
    const m = call.inbound[0]!;
    expect(m).toMatchObject({
      phoneNumberId: PHONE_ID,
      messageId: 'wamid.1',
      waId: '923001112233',
      profileName: 'Ali Raza',
      kind: 'text',
      ad: { id: '120251373303340193', headline: 'Mega Cheese Box Rs 4,800', sourceUrl: 'https://fb.me/abc', ctwaClid: 'ARAkLkA8' },
      text: 'Mega box chahiye, kitne ka hai?',
      reply: null,
    });
  });

  it('reads a tapped button or list row by its id', () => {
    const tap = (interactive: unknown) =>
      readCall({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ from: '923001112233', id: 'w.t', timestamp: '1', type: 'interactive', interactive }] } }] }],
      }).inbound[0];
    expect(tap({ type: 'button_reply', button_reply: { id: 'o:start', title: '🍕 Order karein' } })).toMatchObject({ reply: { id: 'o:start', title: '🍕 Order karein' }, text: null });
    expect(tap({ type: 'list_reply', list_reply: { id: 'c:0', title: 'Value Deals', description: '10 items' } })?.reply).toEqual({ id: 'c:0', title: 'Value Deals' });
  });

  it('the words reach the bot but are never stored', async () => {
    process.env['WHATSAPP_AUTO_REPLY'] = 'off';
    await post(inbound({ waId: '923001110099', id: 'wamid.words' }));
    const dump = JSON.stringify((await db.pg.query(`SELECT * FROM wa_events WHERE wa_id = '923001110099'`, [])).rows) + JSON.stringify(await chat('923001110099'));
    expect(dump).not.toContain('kitne ka hai');
  });

  it('reads staff’s replies from the phone app (coexistence echoes) by the customer they went to', () => {
    expect(readCall(staffEcho({ waId: '923001112233', id: 'wamid.s1' })).staff).toMatchObject([
      { messageId: 'wamid.s1', waId: '923001112233', kind: 'text' },
    ]);
  });

  it('leaves out what is not a message: delivery receipts, other objects, garbage', () => {
    const statuses = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: 'x', status: 'read' }] } }] }],
    };
    for (const body of [statuses, { object: 'page', entry: [] }, null, 'x', { object: 'whatsapp_business_account', entry: 'no' }]) {
      expect(readCall(body)).toEqual({ inbound: [], staff: [] });
    }
  });

  it('answers people writing, never a reaction or a system notice', () => {
    // `unsupported` too (30 Oct 2026): an ad's first message came as one, and went unanswered.
    expect(['text', 'image', 'audio', 'location', 'interactive', 'button', 'order', 'request_welcome', 'unsupported'].every(answersKind)).toBe(true);
    expect(['reaction', 'system'].some(answersKind)).toBe(false);
  });

  it('reads a shared location: the pin, and the place’s name and address when it has them; nothing for a broken one', () => {
    const call = (location: unknown) =>
      readCall({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1356740797521773' }, messages: [{ from: '923365117206', id: 'wamid.pin', timestamp: '1793380000', type: 'location', location }] } }] }],
      }).inbound[0];
    expect(call({ latitude: 24.8654712, longitude: 66.9986116 })).toMatchObject({ kind: 'location', text: null, location: { lat: 24.8654712, lng: 66.9986116, name: null, address: null } });
    expect(call({ latitude: 24.8, longitude: 67.06, name: 'Sunset Lane', address: 'DHA Phase 6' })?.location).toEqual({ lat: 24.8, lng: 67.06, name: 'Sunset Lane', address: 'DHA Phase 6' });
    expect(call({ latitude: 0, longitude: 0 })?.location).toBeNull();
    expect(call({ latitude: 'x', longitude: 67 })?.location).toBeNull();
  });
});

describe('the reply’s words', () => {
  const shop = DEFAULT_SHOP_FACTS;
  const link = orderLinkUrl('Abc23Def45Gh');

  it('open: hello by first name, the shop’s own name from its details, and the link', () => {
    const text = autoReplyText({ shop, open: true, link, profileName: 'Ali Raza' });
    expect(text.startsWith('Hi Ali! ')).toBe(true);
    expect(text).toContain('https://www.cheeseoclock.net/menu?wa=Abc23Def45Gh');
    expect(text).toContain(shop.profile.name.replace("'", '’'));
  });

  it('closed: the hours, and the link for later', () => {
    const text = autoReplyText({ shop, open: false, link, profileName: null });
    expect(text.startsWith('Hi! We’re closed right now (open daily')).toBe(true);
    expect(text).toContain(link);
  });

  it('a WhatsApp name that is not a plain first name is left out', () => {
    expect(greetingName('Ali Raza')).toBe('Ali');
    expect(greetingName('علی')).toBe('علی');
    for (const n of ['~ A L I ~', '🍕', 'x', null, '', 'Mr.Ali']) expect(greetingName(n)).toBeNull();
  });
});

describe('shopDayStart', () => {
  it('the shop’s day runs 5 AM to 5 AM Karachi: half past midnight belongs to the evening before', () => {
    // 26 Oct 00:30 PKT = 25 Oct 19:30 UTC → the day began 25 Oct 05:00 PKT = 25 Oct 00:00 UTC.
    expect(shopDayStart(new Date('2026-10-25T19:30:00Z')).toISOString()).toBe('2026-10-25T00:00:00.000Z');
    // 26 Oct 13:00 PKT = 26 Oct 08:00 UTC → 26 Oct 05:00 PKT.
    expect(shopDayStart(new Date('2026-10-26T08:00:00Z')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});

describe('GET /api/whatsapp/webhook (Meta checks the address)', () => {
  it('echoes the challenge for the right verify token only', async () => {
    process.env['WHATSAPP_VERIFY_TOKEN'] = 'verify-me';
    const ok = route.GET(new Request('https://site.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('12345');
    const wrong = route.GET(new Request('https://site.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1'));
    expect(wrong.status).toBe(403);
    delete process.env['WHATSAPP_VERIFY_TOKEN'];
    const unset = route.GET(new Request('https://site.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1'));
    expect(unset.status).toBe(403);
  });
});

describe('POST /api/whatsapp/webhook', () => {
  it('refuses a call without the app secret’s signature, and keeps nothing', async () => {
    const body = inbound({ waId: '923001110001', id: 'wamid.unsigned' });
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, sign(JSON.stringify(body), 'not-the-secret'))).status).toBe(401);
    delete process.env['META_APP_SECRET'];
    expect((await post(body)).status).toBe(401);
    expect(await chat('923001110001')).toBeUndefined();
    expect(graph).not.toHaveBeenCalled();
  });

  it('a first message from an ad: the chat keeps the ad, the bot sends the link once, Meta’s retry changes nothing', async () => {
    const body = inbound({ waId: '923001110002', id: 'wamid.first', ad: true });
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200); // Meta retries
    expect(await chat('923001110002')).toMatchObject({
      phone: '+923001110002',
      profile_name: 'Ali Raza',
      inbound_count: 1,
      ad_id: '120251373303340193',
      ad_headline: 'Mega Cheese Box Rs 4,800',
    });
    expect(graph).toHaveBeenCalledTimes(1);
    const [url, init] = graph.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/v26.0/${PHONE_ID}/messages`);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer test-token');
    const [msg] = sentTo();
    expect(msg!.to).toBe('923001110002');
    const token = /menu\?wa=([A-Za-z0-9]+)/.exec(msg!.text.body)?.[1];
    const link = (await db.pg.query(`SELECT wa_id, ad_id FROM wa_links WHERE token = $1`, [token])).rows[0];
    expect(link).toEqual({ wa_id: '923001110002', ad_id: '120251373303340193' });
    expect((await events('923001110002')).map((e) => [e['direction'], e['kind'], e['ad_id'], e['ctwa_clid']])).toEqual([
      ['in', 'text', '120251373303340193', 'ARAkLkA8'],
      ['bot', 'text', null, null],
    ]);
  });

  it('one reply a day: the second and third messages get none, even sent at once', async () => {
    const waId = '923001110003';
    await post(inbound({ waId, id: 'wamid.a' }));
    await Promise.all([post(inbound({ waId, id: 'wamid.b' })), post(inbound({ waId, id: 'wamid.c' }))]);
    expect(graph).toHaveBeenCalledTimes(1);
    expect((await chat(waId))?.['inbound_count']).toBe(3);
  });

  it('three messages at once from a new customer still get one reply', async () => {
    const waId = '923001110004';
    await Promise.all(['x', 'y', 'z'].map((s) => post(inbound({ waId, id: `wamid.${s}` }))));
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('a new shop day gets a new reply; staff writing in the last hour hold it back', async () => {
    const waId = '923001110005';
    await post(inbound({ waId, id: 'wamid.d1' }));
    await db.pg.query(`UPDATE wa_chats SET last_auto_at = now() - interval '2 days' WHERE wa_id = $1`, [waId]);
    await post(staffEcho({ waId, id: 'wamid.staff1' }));
    await post(inbound({ waId, id: 'wamid.d2' }));
    expect(graph).toHaveBeenCalledTimes(1);
    await db.pg.query(`UPDATE wa_chats SET last_staff_at = now() - interval '2 hours' WHERE wa_id = $1`, [waId]);
    await post(inbound({ waId, id: 'wamid.d3' }));
    expect(graph).toHaveBeenCalledTimes(2);
    expect((await events(waId)).filter((e) => e['direction'] === 'staff')).toHaveLength(1);
  });

  it('switched off (the owner has not approved the words), or with no access token: kept, not answered', async () => {
    process.env['WHATSAPP_AUTO_REPLY'] = 'off';
    await post(inbound({ waId: '923001110006', id: 'wamid.off' }));
    process.env['WHATSAPP_AUTO_REPLY'] = 'on';
    delete process.env['WHATSAPP_ACCESS_TOKEN'];
    await post(inbound({ waId: '923001110007', id: 'wamid.notoken' }));
    expect(graph).not.toHaveBeenCalled();
    expect((await chat('923001110006'))?.['inbound_count']).toBe(1);
    expect((await chat('923001110007'))?.['inbound_count']).toBe(1);
  });

  it('a reaction, or a message Meta delivers late, is kept but not answered', async () => {
    await post(inbound({ waId: '923001110008', id: 'wamid.react', type: 'reaction' }));
    await post(inbound({ waId: '923001110009', id: 'wamid.late', at: new Date(Date.now() - 60 * 60_000) }));
    expect(graph).not.toHaveBeenCalled();
    expect(await chat('923001110008')).toBeDefined();
  });

  it('a send Meta refuses frees the day’s reply: the next message tries again', async () => {
    const waId = '923001110010';
    graph.mockImplementationOnce(async () => Response.json({ error: { code: 131047, message: 'Re-engagement message' } }, { status: 400 }));
    expect((await post(inbound({ waId, id: 'wamid.f1' }))).status).toBe(200);
    expect((await chat(waId))?.['last_auto_at']).toBeNull();
    await post(inbound({ waId, id: 'wamid.f2' }));
    expect(graph).toHaveBeenCalledTimes(2);
    expect((await chat(waId))?.['last_auto_at']).not.toBeNull();
  });

  it('closed: the reply gives the hours with the link', async () => {
    db.open = false;
    await post(inbound({ waId: '923001110011', id: 'wamid.closed' }));
    expect(sentTo()[0]!.text.body).toContain('We’re closed right now');
  });
});
