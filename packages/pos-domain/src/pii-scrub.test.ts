/**
 * Nothing personal leaves the till in a crash report: phones, e-mails and
 * sign-in secrets are blanked wherever they sit in the event, and an event
 * that cannot be scrubbed is dropped. Every value is made up.
 */
import { describe, expect, it } from 'vitest';
import { scrubEventForSend, scrubPiiText } from './pii-scrub.js';

describe('scrubPiiText', () => {
  it('blanks Pakistani phone numbers in both spellings', () => {
    expect(scrubPiiText('call 03001234567 or +92 300 1234567')).toBe('call 0••••••••• or +92••• ••• ••••');
  });

  it('blanks the local part of an e-mail, keeping the domain for triage', () => {
    expect(scrubPiiText('owner@example.com wrote')).toBe('owner•••@example.com wrote');
  });

  it('blanks sign-in secrets and tokens under their keys, quotes and all', () => {
    const json = '{"pin":"1234","password":"a \\"quoted\\" one","bridgeSecret":"s3","token":"COC1.x.y","name":"keep"}';
    expect(scrubPiiText(json)).toBe('{"pin":"••••","password":"••••","bridgeSecret":"••••","token":"••••","name":"keep"}');
  });
});

describe('scrubEventForSend', () => {
  it('returns the same shape with PII blanked, however deep', () => {
    const event = {
      message: 'Tender failed for 03001234567',
      extra: { customer: { phone: '+923001234567', email: 'a.b@test.pk' }, order: { total: 1200 } },
      user: { pin: '9999' },
    };
    const out = scrubEventForSend(event);
    expect(out).toEqual({
      message: 'Tender failed for 0•••••••••',
      extra: { customer: { phone: '+92••• ••• ••••', email: 'a.b•••@test.pk' }, order: { total: 1200 } },
      user: { pin: '••••' },
    });
    // The original is left alone.
    expect(event.user.pin).toBe('9999');
  });

  it('drops what it cannot clean: a cycle, a non-object, nothing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(scrubEventForSend(cyclic)).toBeNull();
    expect(scrubEventForSend(null as unknown as object)).toBeNull();
    expect(scrubEventForSend('text' as unknown as object)).toBeNull();
  });
});
