import { describe, expect, it } from 'vitest';
import { addToast, toastDuration, type ToastItem } from '../../components/toast/toastQueue';
import {
  failedPrintNote,
  SHIFT_REPORT_FAILED_NEXT,
  SHIFT_REPORT_FAILED_OWNER,
  SHIFT_REPORT_FAILED_TITLE,
  shiftReportFailedNoteId,
} from './failedPrintNote';

const OFF = { code: 'offline', message: 'The printer is off, offline, out of paper or its lid is open.' };

describe('the failed-print note', () => {
  it('names the paper and the order, and "Try again" sends that very job', () => {
    const tried: string[] = [];
    const n = failedPrintNote({ jobId: 'job-41', jobKind: 'receipt', orderId: 'o41', what: 'Receipt for Order #0041', error: OFF }, (id) =>
      tried.push(id),
    );
    expect(n).toMatchObject({ title: 'Receipt for Order #0041 did not print', description: OFF.message, variant: 'error' });
    expect(n.action).toMatchObject({ label: 'Try again', key: 'job-41' });
    n.action!.onClick();
    expect(tried).toEqual(['job-41']);
  });

  it('two orders failing with the same printer error stay two notes, each with its own "Try again"', () => {
    const toItem = (jobId: string, what: string): ToastItem => {
      const n = failedPrintNote({ jobId, jobKind: 'receipt', what, error: OFF }, () => {});
      return { id: jobId, ...n, duration: toastDuration(n.variant) };
    };
    let list = addToast([], toItem('job-41', 'Receipt for Order #0041'));
    list = addToast(list, toItem('job-42', 'Receipt for Order #0042'));
    expect(list.map((t) => [t.title, t.action?.key])).toEqual([
      ['Receipt for Order #0041 did not print', 'job-41'],
      ['Receipt for Order #0042 did not print', 'job-42'],
    ]);
    // Even from a till that does not send the words yet: the job keeps them apart.
    let bare = addToast([], toItem('job-41', ''));
    bare = addToast(bare, toItem('job-42', ''));
    expect(bare.map((t) => [t.title, t.action?.key])).toEqual([
      ['Print failed', 'job-41'],
      ['Print failed', 'job-42'],
    ]);
  });

  it('a retry on its way is a warning without a button; a drawer pulse is never offered again', () => {
    const retrying = failedPrintNote({ jobId: 'j', jobKind: 'kitchen', what: 'Kitchen ticket for Order #0042', error: OFF, retrying: true }, () => {});
    expect(retrying).toEqual({ title: 'Printer not responding — Kitchen ticket for Order #0042 will retry', description: OFF.message, variant: 'warning' });
    expect(failedPrintNote({ jobKind: 'kitchen', retrying: true }, () => {}).title).toBe('Printer not responding — kitchen ticket will retry');
    expect(failedPrintNote({ jobId: 'j', jobKind: 'drawer', error: OFF }, () => {}).action).toBeUndefined();
    expect(failedPrintNote({ jobKind: 'receipt' }, () => {})).toEqual({ title: 'Print failed', description: 'Could not print receipt', variant: 'error' });
  });
});

describe('the shift report did not print (v0.7.35)', () => {
  // As the till sends it (print-spooler notifyShiftReportFailure): no job, no order — the shift.
  const failed = { jobKind: 'shift_report', shiftId: 'shift-7', what: 'Shift report', error: OFF, retrying: false };

  it('says so, and what to do; "Try again" is keyed to the shift and asks for that shift’s report', () => {
    const jobs: string[] = [];
    const shifts: string[] = [];
    const n = failedPrintNote(
      failed,
      (id) => jobs.push(id),
      (id) => shifts.push(id),
    );
    expect(SHIFT_REPORT_FAILED_TITLE).toBe('Shift report did not print');
    expect(SHIFT_REPORT_FAILED_NEXT).toBe('Press Try again, or the owner prints it from Shift history.');
    expect(n).toMatchObject({
      title: 'Shift report did not print',
      description: `${OFF.message} Press Try again, or the owner prints it from Shift history.`,
      // It stays until closed: it still works after the close result is gone.
      variant: 'error',
    });
    expect(n.action).toMatchObject({ label: 'Try again', key: 'shift-report:shift-7' });
    n.action!.onClick();
    expect(shifts).toEqual(['shift-7']);
    // Never a print job sent again: the shift report has none.
    expect(jobs).toEqual([]);
  });

  it('two shifts stay two notes; the printer’s words get a full stop', () => {
    const toItem = (shiftId: string): ToastItem => {
      const n = failedPrintNote({ ...failed, shiftId }, () => {}, () => {});
      return { id: shiftId, ...n, duration: toastDuration(n.variant) };
    };
    const list = addToast(addToast([], toItem('shift-7')), toItem('shift-8'));
    expect(list.map((t) => t.action?.key)).toEqual(['shift-report:shift-7', 'shift-report:shift-8']);
    expect(failedPrintNote({ ...failed, error: { code: 'timeout', message: 'Printer did not answer' } }, () => {}, () => {}).description).toBe(
      `Printer did not answer. ${SHIFT_REPORT_FAILED_NEXT}`,
    );
  });

  it('with no shift named, or no way to try: no button, and the owner’s way instead', () => {
    const owners = { title: SHIFT_REPORT_FAILED_TITLE, description: `${OFF.message} ${SHIFT_REPORT_FAILED_OWNER}`, variant: 'error' };
    expect(failedPrintNote({ ...failed, shiftId: undefined }, () => {}, () => {})).toEqual(owners);
    // The shift is named: the note keeps that shift's id, so a print that comes out closes it.
    expect(failedPrintNote(failed, () => {})).toEqual({ id: shiftReportFailedNoteId('shift-7'), ...owners });
    expect(SHIFT_REPORT_FAILED_OWNER).toBe('The owner can print it from Shift history.');
  });

  it('(e2e fixes) one note per shift, by its id: a later failure of the same shift replaces it; another shift’s stays', () => {
    expect(shiftReportFailedNoteId('shift-7')).toBe('shift-report-failed:shift-7');
    const toItem = (shiftId: string, message: string): ToastItem => {
      const n = failedPrintNote({ ...failed, shiftId, error: { code: 'offline', message } }, () => {}, () => {});
      return { id: `fresh-${message}`, ...n, duration: toastDuration(n.variant) };
    };
    let list = addToast([], toItem('shift-7', 'connect ECONNREFUSED 127.0.0.1:9101'));
    list = addToast(list, toItem('shift-8', 'Printer did not answer'));
    list = addToast(list, toItem('shift-7', 'Printer did not answer'));
    expect(list.map((t) => [t.id, t.description])).toEqual([
      [shiftReportFailedNoteId('shift-8'), `Printer did not answer. ${SHIFT_REPORT_FAILED_NEXT}`],
      [shiftReportFailedNoteId('shift-7'), `Printer did not answer. ${SHIFT_REPORT_FAILED_NEXT}`],
    ]);
    // Receipts and kitchen tickets keep no id of their own (each a fresh note, keyed by its job).
    expect(failedPrintNote({ jobId: 'job-41', jobKind: 'receipt', what: 'Receipt for Order #0041', error: OFF }, () => {})).not.toHaveProperty('id');
  });

  it('receipts and kitchen tickets are as they were', () => {
    const shifts: string[] = [];
    const receipt = failedPrintNote({ jobId: 'job-41', jobKind: 'receipt', what: 'Receipt for Order #0041', error: OFF }, () => {}, (id) => shifts.push(id));
    expect(receipt).toMatchObject({ title: 'Receipt for Order #0041 did not print', description: OFF.message, variant: 'error' });
    expect(receipt.action).toMatchObject({ label: 'Try again', key: 'job-41' });
    const kitchen = failedPrintNote({ jobId: 'job-42', jobKind: 'kitchen', what: 'Kitchen ticket for Order #0042', error: OFF }, () => {}, (id) => shifts.push(id));
    expect(kitchen).toMatchObject({ title: 'Kitchen ticket for Order #0042 did not print', description: OFF.message });
    expect(kitchen.action?.key).toBe('job-42');
    receipt.action!.onClick();
    kitchen.action!.onClick();
    expect(shifts).toEqual([]);
  });
});
