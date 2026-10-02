/**
 * The shift report printed again from the screen (v0.7.35): the close
 * result's Print again / Try again / Print it, and Try again on the note
 * that it did not print. The till decides who may and what prints; on a
 * cashier's login it asks for a manager's PIN or password (refused with
 * needs 'manager_pin'), and the screen asks for one in the app — never the
 * browser's prompt — and sends it with the same request. Nothing here calls
 * a real till; every name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShiftReportPrintResult } from '@cheeseoclock/shared-types';

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  answers: [] as Array<() => unknown>,
  asked: [] as Array<{ message: string; error: string | null; printNo: number | null; paperNote: string | null }>,
  secrets: [] as Array<string | null>,
}));

vi.mock('../../ipc/client', () => {
  class IpcError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(e: { code: string; message: string; details?: Record<string, unknown> }) {
      super(e.message);
      this.code = e.code;
      if (e.details) this.details = e.details;
    }
  }
  return {
    IpcError,
    ipc: {
      shifts: {
        printReport: async (request: Record<string, unknown>) => {
          h.calls.push(request);
          const next = h.answers.shift();
          if (!next) throw new Error('no answer scripted');
          return next();
        },
      },
    },
  };
});
vi.mock('../printing/managerApproval', () => ({
  askManagerSecret: async (message: string, error: string | null = null, printNo: number | null = null, paperNote: string | null = null) => {
    h.asked.push({ message, error, printNo, paperNote });
    return h.secrets.shift() ?? null;
  },
}));

const { IpcError } = (await import('../../ipc/client')) as unknown as {
  IpcError: new (e: { code: string; message: string; details?: Record<string, unknown> }) => Error;
};
const {
  printShiftReport,
  printShiftReportAndSay,
  shiftReportApprovalNote,
  shiftReportRefusedToast,
  shiftReportToast,
  SHIFT_REPORT_SENT,
  SHIFT_REPORT_SENT_DUPLICATE,
} = await import('./shiftReportPrint');
const { NO_APPROVAL_MESSAGE } = await import('../printing/reprint');
const { dismissShiftCloseOutcome, noteShiftReportFailed, showShiftCloseOutcome, useShiftCloseOutcome } = await import(
  './shiftCloseOutcome'
);
const { useSessionStore } = await import('../../stores/sessionStore');

const PIN_NEEDED = "A manager's PIN or password is needed to print the shift report";
const WRONG = "That is not a manager's PIN or password";
const OFF = 'The printer is off, offline, out of paper or its lid is open.';

const needs = (message: string, extra: Record<string, unknown> = {}) => () => {
  throw new IpcError({ code: 'forbidden', message, details: { needs: 'manager_pin', ...extra } });
};
const reprint = (reprintNo = 1): (() => ShiftReportPrintResult) => () => ({ printed: true, copy: 'reprint', reprintNo, error: null });
const original = (): ShiftReportPrintResult => ({ printed: true, copy: 'original', reprintNo: 0, error: null });

beforeEach(() => {
  h.calls.length = 0;
  h.answers.length = 0;
  h.asked.length = 0;
  h.secrets.length = 0;
  dismissShiftCloseOutcome();
});

describe('printShiftReport — asking a manager when the till needs one', () => {
  it('a manager or the owner signed in: one call, no question', async () => {
    h.answers.push(reprint(1));
    await expect(printShiftReport('shift-1', { again: true })).resolves.toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    expect(h.calls).toEqual([{ shiftId: 'shift-1', again: true }]);
    expect(h.asked).toEqual([]);
  });

  it('needs manager_pin: asks in the app with the till’s words, then sends the secret with the same request', async () => {
    h.answers.push(needs(PIN_NEEDED), original);
    h.secrets.push('Manager-pass-7');
    await expect(printShiftReport('shift-1', { again: false })).resolves.toMatchObject({ copy: 'original' });
    expect(h.asked).toEqual([{ message: PIN_NEEDED, error: null, printNo: null, paperNote: shiftReportApprovalNote(false) }]);
    expect(h.calls).toEqual([
      { shiftId: 'shift-1', again: false },
      { shiftId: 'shift-1', again: false, approverPin: 'Manager-pass-7' },
    ]);
  });

  it('a wrong secret is asked again, with why, keeping the reason', async () => {
    h.answers.push(needs(PIN_NEEDED), needs(WRONG, { wrongSecret: true }), reprint(2));
    h.secrets.push('1234', 'Manager-pass-7');
    await expect(printShiftReport('shift-1', { again: true })).resolves.toMatchObject({ reprintNo: 2 });
    expect(h.asked.map(({ message, error }) => ({ message, error }))).toEqual([
      { message: PIN_NEEDED, error: null },
      { message: PIN_NEEDED, error: WRONG },
    ]);
    expect(h.calls.at(-1)).toEqual({ shiftId: 'shift-1', again: true, approverPin: 'Manager-pass-7' });
  });

  it('cancelled: nothing printed, and it says so', async () => {
    h.answers.push(needs(PIN_NEEDED));
    h.secrets.push(null);
    await expect(printShiftReport('shift-1', { again: true })).rejects.toThrow(NO_APPROVAL_MESSAGE);
    expect(NO_APPROVAL_MESSAGE).toBe('Not printed - no manager approval');
    expect(h.calls).toHaveLength(1);
  });

  it('gives up after a few wrong secrets', async () => {
    for (let i = 0; i < 6; i += 1) h.answers.push(needs(WRONG, { wrongSecret: true }));
    for (let i = 0; i < 6; i += 1) h.secrets.push('0000');
    await expect(printShiftReport('shift-1', { again: true })).rejects.toThrow(WRONG);
    expect(h.calls.length).toBeLessThanOrEqual(4);
  });

  it('any other refusal is passed on as it is, with no question', async () => {
    h.answers.push(() => {
      throw new IpcError({ code: 'forbidden', message: 'Only the owner can print an older shift report - from Shift history' });
    });
    await expect(printShiftReport('shift-1', { again: true })).rejects.toThrow(/Only the owner/);
    expect(h.asked).toEqual([]);
  });

  it('the PIN box promises only what the paper will say (not the receipt’s "manager’s name")', () => {
    expect(shiftReportApprovalNote(true)).toBe('The shift report prints again from the figures saved at the close. It says DUPLICATE.');
    expect(shiftReportApprovalNote(false)).toBe(
      'The shift report prints from the figures saved at the close. If the first paper never came out, this is the original; if it did, this one says DUPLICATE.',
    );
    for (const again of [true, false]) expect(shiftReportApprovalNote(again)).not.toMatch(/name/);
  });
});

describe('shiftReportToast — what came out, or why not', () => {
  it('the original, and a DUPLICATE', () => {
    expect(SHIFT_REPORT_SENT).toBe('Shift report sent to the printer.');
    expect(shiftReportToast(original())).toEqual({ title: 'Shift report sent to the printer.', variant: 'success' });
    expect(shiftReportToast(reprint(3)())).toEqual({ title: SHIFT_REPORT_SENT_DUPLICATE, variant: 'success' });
    expect(SHIFT_REPORT_SENT_DUPLICATE).toBe('Shift report sent to the printer - it says DUPLICATE.');
  });

  it('did not print: the printer’s words, then check the printer and try again', () => {
    expect(shiftReportToast({ printed: false, copy: 'original', reprintNo: 0, error: { code: 'offline', message: OFF } })).toEqual({
      title: 'The shift report did not print',
      description: `${OFF} Check the receipt printer, then try again.`,
      variant: 'error',
    });
    // Words without a full stop get one.
    expect(shiftReportToast({ printed: false, copy: 'reprint', reprintNo: 1, error: { code: 'timeout', message: 'Printer did not answer' } }).description).toBe(
      'Printer did not answer. Check the receipt printer, then try again.',
    );
  });

  it('no receipt printer set up: not told to check a printer that is not there', () => {
    const t = shiftReportToast({
      printed: false,
      copy: 'reprint',
      reprintNo: 1,
      error: { code: 'no_printer', message: 'No receipt printer is set up on this till' },
    });
    expect(t).toEqual({ title: 'The shift report did not print', description: 'No receipt printer is set up on this till.', variant: 'error' });
    expect(t.description).not.toMatch(/check/i);
  });

  it('a paper may be in the tray: said so, before anyone prints another', () => {
    const t = shiftReportToast({ printed: false, copy: 'reprint', reprintNo: 1, error: { code: 'io', message: OFF, maybeSent: true } });
    expect(t).toMatchObject({ title: 'The shift report may have printed', variant: 'warning' });
    expect(t.description).toBe(`${OFF} Look in the printer's tray before you print it again.`);
  });

  it('refused or cancelled: the till’s words', () => {
    expect(shiftReportRefusedToast(new Error(NO_APPROVAL_MESSAGE))).toEqual({
      title: 'Shift report not printed',
      description: 'Not printed - no manager approval',
      variant: 'error',
    });
  });
});

describe('printShiftReportAndSay — print, say it, and tell the close result', () => {
  const closed = () =>
    showShiftCloseOutcome({
      sessionId: 's1',
      shiftId: 'shift-1',
      expectedCents: null,
      countedCents: 1_000_000,
      countedNotes: null,
      varianceCents: 0,
      summary: null,
      closedByName: 'Sara Manager',
      carriedUnpaidCount: 0,
      viaManagerPin: false,
      reportPrint: 'printing',
      reportError: null,
    });
  const signedIn = () =>
    useSessionStore.setState({ user: { id: 'u1', fullName: 'Test', role: 'manager', sessionId: 's1' } as never, status: 'authenticated' });

  it('printed: the toast, and the result’s amber line goes', async () => {
    signedIn();
    closed();
    noteShiftReportFailed('shift-1', OFF);
    h.answers.push(original);
    const said: unknown[] = [];
    await expect(printShiftReportAndSay('shift-1', false, (t) => said.push(t))).resolves.toMatchObject({ copy: 'original' });
    expect(said).toEqual([{ title: SHIFT_REPORT_SENT, variant: 'success' }]);
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBeNull();
  });

  it('did not print on a printer: the result says why; on no printer it stays as it was', async () => {
    signedIn();
    closed();
    h.answers.push(() => ({ printed: false, copy: 'reprint', reprintNo: 1, error: { code: 'offline', message: OFF } }));
    await printShiftReportAndSay('shift-1', true, () => {});
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBe(OFF);

    closed();
    h.answers.push(() => ({ printed: false, copy: 'reprint', reprintNo: 1, error: { code: 'no_printer', message: 'No receipt printer is set up on this till' } }));
    await printShiftReportAndSay('shift-1', true, () => {});
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBeNull();
  });

  it('refused or cancelled: a toast, never a throw, and the result is left as it was', async () => {
    signedIn();
    closed();
    h.answers.push(needs(PIN_NEEDED));
    h.secrets.push(null);
    const said: Array<{ title: string; description?: string }> = [];
    const before = useShiftCloseOutcome.getState().outcome;
    await expect(printShiftReportAndSay('shift-1', true, (t) => said.push(t))).resolves.toBeNull();
    expect(said).toEqual([{ title: 'Shift report not printed', description: NO_APPROVAL_MESSAGE, variant: 'error' }]);
    expect(useShiftCloseOutcome.getState().outcome).toBe(before);
  });

  it('another shift’s print leaves the result alone', async () => {
    signedIn();
    closed();
    noteShiftReportFailed('shift-1', OFF);
    h.answers.push(reprint(1));
    await printShiftReportAndSay('shift-2', true, () => {});
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBe(OFF);
  });
});
