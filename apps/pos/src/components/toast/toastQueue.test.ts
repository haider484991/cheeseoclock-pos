import { describe, expect, it } from 'vitest';
import { addToast, toastDuration, visibleToasts, type ToastItem, type ToastVariant } from './toastQueue';

let n = 0;
const note = (variant: ToastVariant, title = `note ${++n}`, description?: string): ToastItem => ({
  id: `id-${++n}`,
  title,
  description,
  variant,
  duration: toastDuration(variant),
});

describe('toastDuration', () => {
  it('keeps errors until they are closed, whatever the caller asked', () => {
    expect(toastDuration('error')).toBe(Infinity);
    expect(toastDuration('error', 3_000)).toBe(Infinity);
  });

  it('clears a success quickly', () => {
    expect(toastDuration('success')).toBe(2_000);
    expect(toastDuration('success', 10_000)).toBe(3_000);
    expect(toastDuration('success', 1_500)).toBe(1_500);
  });

  it("keeps a caller's own time for info and warnings", () => {
    expect(toastDuration('info')).toBe(5_000);
    expect(toastDuration('warning')).toBe(6_000);
    expect(toastDuration('warning', 60_000)).toBe(60_000);
    expect(toastDuration('info', Infinity)).toBe(Infinity);
    expect(toastDuration('info', 0)).toBe(5_000);
  });
});

describe('addToast', () => {
  it('never holds more than three notes that close by themselves', () => {
    let list: ToastItem[] = [];
    const pushed: ToastItem[] = [];
    for (let i = 0; i < 6; i++) {
      const t = note('success');
      pushed.push(t);
      list = addToast(list, t);
    }
    // The three newest, oldest first.
    expect(list.map((t) => t.id)).toEqual(pushed.slice(3).map((t) => t.id));
  });

  it('drops the oldest self-closing note first and keeps the errors', () => {
    const err = note('error', 'Printer offline');
    let list = addToast([], err);
    const a = note('info', 'a');
    const b = note('success', 'b');
    list = addToast(list, a);
    list = addToast(list, b);
    list = addToast(list, note('success', 'c'));
    expect(list.map((t) => t.title)).toEqual(['Printer offline', 'b', 'c']);
  });

  it('keeps every error even past the limit; the screen shows the newest', () => {
    let list: ToastItem[] = [];
    for (const t of ['e1', 'e2', 'e3', 'e4']) list = addToast(list, note('error', t));
    expect(list).toHaveLength(4);
    const { shown, waiting } = visibleToasts(list);
    expect(shown.map((t) => t.title)).toEqual(['e2', 'e3', 'e4']);
    expect(waiting).toBe(1);
  });

  it('a success is dropped rather than push an error off the screen', () => {
    let list: ToastItem[] = [];
    for (const t of ['e1', 'e2', 'e3']) list = addToast(list, note('error', t));
    list = addToast(list, note('success', 'Sent'));
    expect(list.map((t) => t.title)).toEqual(['e1', 'e2', 'e3']);
  });

  it('the same message again replaces the old copy instead of stacking', () => {
    const first = note('warning', 'Cannot pay yet', 'customer phone');
    let list = addToast([], first);
    list = addToast(list, note('info', 'other'));
    const again = note('warning', 'Cannot pay yet', 'customer phone');
    list = addToast(list, again);
    expect(list.map((t) => t.id)).toEqual([list[0]!.id, again.id]);
    expect(list.filter((t) => t.title === 'Cannot pay yet')).toHaveLength(1);
    // A different description is a different message.
    list = addToast(list, note('warning', 'Cannot pay yet', 'customer name'));
    expect(list.filter((t) => t.title === 'Cannot pay yet')).toHaveLength(2);
  });
});
