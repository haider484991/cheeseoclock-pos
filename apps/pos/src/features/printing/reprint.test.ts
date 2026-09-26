import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ orderId: string; opts: Record<string, unknown> }>,
  answers: [] as Array<() => unknown>,
  asked: [] as Array<{ message: string; error: string | null }>,
  /** What the dialog was told about the paper (printNo), per question. */
  printNos: [] as Array<number | null>,
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
      printer: {
        reprint: async (orderId: string, opts: Record<string, unknown>) => {
          h.calls.push({ orderId, opts });
          const next = h.answers.shift();
          if (!next) throw new Error('no answer scripted');
          return next();
        },
        reprintKitchen: async () => ({ status: 'queued', document: 'kitchen', duplicate: true, printNo: 1 }),
      },
    },
  };
});
vi.mock('./managerApproval', () => ({
  askManagerSecret: async (message: string, error: string | null, printNo: number | null = null) => {
    h.asked.push({ message, error });
    h.printNos.push(printNo);
    return h.secrets.shift() ?? null;
  },
}));

const { IpcError } = (await import('../../ipc/client')) as unknown as {
  IpcError: new (e: { code: string; message: string; details?: Record<string, unknown> }) => Error;
};
const { reprintReceipt, reprintToast, NO_APPROVAL_MESSAGE } = await import('./reprint');

const needs = (message: string, extra: Record<string, unknown> = {}) => () => {
  throw new IpcError({ code: 'forbidden', message, details: { needs: 'manager_pin', document: 'receipt', printNo: 1, ...extra } });
};
const queued = () => ({ status: 'queued', document: 'receipt', duplicate: true, printNo: 1 });

beforeEach(() => {
  h.calls.length = 0;
  h.answers.length = 0;
  h.asked.length = 0;
  h.printNos.length = 0;
  h.secrets.length = 0;
});

describe('reprintReceipt — asking a manager when the till needs one', () => {
  it('no approval needed: one call, no question', async () => {
    h.answers.push(queued);
    await expect(reprintReceipt('o1')).resolves.toMatchObject({ status: 'queued' });
    expect(h.calls).toEqual([{ orderId: 'o1', opts: {} }]);
    expect(h.asked).toEqual([]);
  });

  it('asks with the reason, then sends the secret with the same request', async () => {
    h.answers.push(needs("Order #0042's receipt was already printed once."), queued);
    h.secrets.push('Manager-pass-7');
    await expect(reprintReceipt('o1', { copy: 'shop' })).resolves.toMatchObject({ status: 'queued' });
    expect(h.asked).toEqual([{ message: "Order #0042's receipt was already printed once.", error: null }]);
    expect(h.calls.map((c) => c.opts)).toEqual([{ copy: 'shop' }, { copy: 'shop', approverPin: 'Manager-pass-7' }]);
  });

  it("a wrong secret is asked again, with why, keeping the reason", async () => {
    h.answers.push(needs('Paid more than 30 minutes ago.'), needs("That is not a manager's PIN or password", { wrongSecret: true }), queued);
    h.secrets.push('1234', 'Manager-pass-7');
    await reprintReceipt('o1');
    expect(h.asked).toEqual([
      { message: 'Paid more than 30 minutes ago.', error: null },
      { message: 'Paid more than 30 minutes ago.', error: "That is not a manager's PIN or password" },
    ]);
    expect(h.calls.at(-1)!.opts).toEqual({ approverPin: 'Manager-pass-7' });
  });

  it('cancelled: nothing printed, and it says so', async () => {
    h.answers.push(needs('Paid more than 30 minutes ago.'));
    h.secrets.push(null);
    await expect(reprintReceipt('o1')).rejects.toThrow(NO_APPROVAL_MESSAGE);
    expect(h.calls).toHaveLength(1);
  });

  it('any other refusal is passed on as it is', async () => {
    h.answers.push(() => {
      throw new IpcError({ code: 'forbidden', message: 'This order is from an earlier shift. Ask a manager to reprint it.' });
    });
    await expect(reprintReceipt('o1')).rejects.toThrow(/earlier shift/);
    expect(h.asked).toEqual([]);
  });

  it("tells the dialog whether the paper will be a DUPLICATE (the till's printNo)", async () => {
    // A first paper (printed later, approved): not a duplicate. Then one already printed.
    h.answers.push(needs('Paid more than 30 minutes ago.', { printNo: 0 }), queued);
    h.answers.push(needs('Already printed once.', { printNo: 1 }), queued);
    h.answers.push(needs('An older till said nothing.', { printNo: undefined }), queued);
    h.secrets.push('Manager-pass-7', 'Manager-pass-7', 'Manager-pass-7');
    await reprintReceipt('o1');
    await reprintReceipt('o2');
    await reprintReceipt('o3');
    expect(h.printNos).toEqual([0, 1, null]);
  });

  it('gives up after a few wrong secrets', async () => {
    for (let i = 0; i < 5; i += 1) h.answers.push(needs('wrong', { wrongSecret: true }));
    for (let i = 0; i < 5; i += 1) h.secrets.push('0000');
    await expect(reprintReceipt('o1')).rejects.toThrow('wrong');
    expect(h.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('reprintToast', () => {
  it('says what went to the printer', () => {
    expect(reprintToast({ status: 'merged', document: 'receipt', duplicate: false, printNo: 0 })).toBe('Already on its way to the printer');
    expect(reprintToast({ status: 'queued', document: 'receipt', duplicate: true, printNo: 1 })).toBe('Receipt sent — marked DUPLICATE');
    expect(reprintToast({ status: 'queued', document: 'bill', duplicate: false, printNo: 0 })).toBe('Bill (not paid) sent to printer');
    expect(reprintToast({ status: 'queued', document: 'void', duplicate: false, printNo: 0 })).toBe('Cancelled-order slip sent to printer');
    expect(reprintToast({ status: 'queued', document: 'kitchen', duplicate: true, printNo: 1 })).toBe('Kitchen ticket sent — marked REPRINT');
    // Earlier tickets only may have printed: the paper says RE-SENT / check the rail, and so does the toast.
    const resent = reprintToast({ status: 'queued', document: 'kitchen', duplicate: false, resent: true, printNo: 5 });
    expect(resent).toBe('Kitchen ticket re-sent — the kitchen should check the rail before cooking');
    expect(resent).not.toContain('REPRINT');
    expect(reprintToast({ status: 'queued', document: 'kitchen', duplicate: false, printNo: 0 })).toBe('Kitchen ticket sent to printer');
  });
});

describe('the manager-approval dialog', () => {
  it('promises only what the paper will say', async () => {
    const { approvalPaperNote } = await vi.importActual<typeof import('./managerApproval')>('./managerApproval');
    expect(approvalPaperNote(2)).toBe("The paper will say DUPLICATE and show the manager's name.");
    // The common case: a cashier's first paper for an order paid long ago prints "Printed later", not DUPLICATE.
    expect(approvalPaperNote(0)).toContain('not a DUPLICATE');
    expect(approvalPaperNote(0)).toContain("manager's name");
    expect(approvalPaperNote(null)).toContain('DUPLICATE if it was printed before');
  });
});
