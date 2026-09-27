import { describe, expect, it } from 'vitest';
import { addToast, toastDuration, type ToastItem } from '../../components/toast/toastQueue';
import { failedPrintNote } from './failedPrintNote';

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
