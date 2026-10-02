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
  shiftReportPrintNoteId,
  shiftReportRefusedToast,
  shiftReportToast,
  SHIFT_REPORT_NOT_SAVED,
  SHIFT_REPORT_SAVED_NO_PRINTER,
  SHIFT_REPORT_SENT,
  SHIFT_REPORT_SENT_DUPLICATE,
} = await import('./shiftReportPrint');
const { shiftReportFailedNoteId } = await import('../printing/failedPrintNote');
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

  it('(e2e fixes) the "No printer" setup: saved to its file, said in a note that goes by itself (never a red "did not print")', () => {
    expect(SHIFT_REPORT_SAVED_NO_PRINTER).toBe('Shift report saved (no receipt printer set up).');
    for (const r of [
      { printed: true, copy: 'reprint', reprintNo: 2, error: null, toFile: true },
      { printed: true, copy: 'original', reprintNo: 0, error: null, toFile: true },
    ] as const) {
      expect(shiftReportToast(r)).toEqual({ title: SHIFT_REPORT_SAVED_NO_PRINTER, variant: 'info' });
    }
    // The file could not be written: said so, with no printer to check.
    const t = shiftReportToast({ printed: false, copy: 'reprint', reprintNo: 1, error: { code: 'mock_write_failed', message: 'EACCES' }, toFile: true });
    expect(t).toEqual({ title: SHIFT_REPORT_NOT_SAVED, description: 'EACCES.', variant: 'error' });
    expect(SHIFT_REPORT_NOT_SAVED).toBe('The shift report was not saved');
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

/** The till's notes as printShiftReportAndSay is given them (useToast()): what it said, and what it closed. */
function tillNotes() {
  const said: Array<{ id: string; title: string; description?: string; variant: string }> = [];
  const dismissed: string[] = [];
  return {
    said,
    dismissed,
    toast: (t: (typeof said)[number]) => void said.push(t),
    dismiss: (id: string) => void dismissed.push(id),
  };
}

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
    const notes = tillNotes();
    await expect(printShiftReportAndSay('shift-1', false, notes)).resolves.toMatchObject({ copy: 'original' });
    expect(notes.said).toEqual([{ id: shiftReportPrintNoteId('shift-1'), title: SHIFT_REPORT_SENT, variant: 'success' }]);
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBeNull();
  });

  it('did not print on a printer: the result says why; saved on "No printer": the amber line goes', async () => {
    signedIn();
    closed();
    h.answers.push(() => ({ printed: false, copy: 'reprint', reprintNo: 1, error: { code: 'offline', message: OFF } }));
    await printShiftReportAndSay('shift-1', true, tillNotes());
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBe(OFF);

    h.answers.push(() => ({ printed: true, copy: 'reprint', reprintNo: 1, error: null, toFile: true }));
    const notes = tillNotes();
    await printShiftReportAndSay('shift-1', true, notes);
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBeNull();
    expect(notes.said).toEqual([{ id: shiftReportPrintNoteId('shift-1'), title: SHIFT_REPORT_SAVED_NO_PRINTER, variant: 'info' }]);
  });

  it('(e2e fixes) a later print that comes out closes that shift’s red "did not print" note (its id), and its own note takes the place of the last one', async () => {
    signedIn();
    closed();
    noteShiftReportFailed('shift-1', OFF);
    // A try that does not print: the till's note stays (its Try again still works), the print's note says why.
    h.answers.push(() => ({ printed: false, copy: 'original', reprintNo: 0, error: { code: 'offline', message: OFF } }));
    const failedTry = tillNotes();
    await printShiftReportAndSay('shift-1', false, failedTry);
    expect(failedTry.dismissed).toEqual([]);
    expect(failedTry.said).toEqual([
      {
        id: shiftReportPrintNoteId('shift-1'),
        title: 'The shift report did not print',
        description: `${OFF} Check the receipt printer, then try again.`,
        variant: 'error',
      },
    ]);
    // Try again once the printer is back: it prints, and the red notes go.
    h.answers.push(original);
    const printed = tillNotes();
    await printShiftReportAndSay('shift-1', false, printed);
    expect(printed.dismissed).toEqual([shiftReportFailedNoteId('shift-1')]);
    // Under the same id as the failed try's note: it takes its place on screen.
    expect(printed.said).toEqual([{ id: shiftReportPrintNoteId('shift-1'), title: SHIFT_REPORT_SENT, variant: 'success' }]);
    // A paper that may be in the tray, or a refusal, closes nothing.
    h.answers.push(() => ({ printed: false, copy: 'reprint', reprintNo: 1, error: { code: 'io', message: OFF, maybeSent: true } }));
    h.answers.push(needs(PIN_NEEDED));
    h.secrets.push(null);
    for (let i = 0; i < 2; i += 1) {
      const n = tillNotes();
      await printShiftReportAndSay('shift-1', true, n);
      expect(n.dismissed).toEqual([]);
      expect(n.said.map((t) => t.id)).toEqual([shiftReportPrintNoteId('shift-1')]);
    }
    // Another shift's print closes only its own.
    h.answers.push(reprint(1));
    const other = tillNotes();
    await printShiftReportAndSay('shift-2', true, other);
    expect(other.dismissed).toEqual([shiftReportFailedNoteId('shift-2')]);
    expect(shiftReportPrintNoteId('shift-1')).not.toBe(shiftReportPrintNoteId('shift-2'));
  });

  it('refused or cancelled: a toast, never a throw, and the result is left as it was', async () => {
    signedIn();
    closed();
    h.answers.push(needs(PIN_NEEDED));
    h.secrets.push(null);
    const notes = tillNotes();
    const before = useShiftCloseOutcome.getState().outcome;
    await expect(printShiftReportAndSay('shift-1', true, notes)).resolves.toBeNull();
    expect(notes.said).toEqual([
      { id: shiftReportPrintNoteId('shift-1'), title: 'Shift report not printed', description: NO_APPROVAL_MESSAGE, variant: 'error' },
    ]);
    expect(useShiftCloseOutcome.getState().outcome).toBe(before);
  });

  it('another shift’s print leaves the result alone', async () => {
    signedIn();
    closed();
    noteShiftReportFailed('shift-1', OFF);
    h.answers.push(reprint(1));
    await printShiftReportAndSay('shift-2', true, tillNotes());
    expect(useShiftCloseOutcome.getState().outcome?.reportError).toBe(OFF);
  });
});
