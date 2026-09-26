import { describe, expect, it } from 'vitest';
import { addedLineId, createSerialQueue, findMergeableLine } from './cartLines';

const line = (id: string, menuItemId: string, extra: Partial<{ notes: string | null; modifiers: unknown[]; comboId: string | null; parentOrderItemId: string | null; quantity: number }> = {}) => ({
  id,
  menuItemId,
  comboId: null,
  parentOrderItemId: null,
  quantity: 1,
  notes: null,
  modifiers: [] as unknown[],
  ...extra,
});

describe('findMergeableLine', () => {
  it('finds the plain line for a plain tap on the same item', () => {
    const items = [line('a', 'coke'), line('b', 'fries')];
    expect(findMergeableLine(items, 'coke', [], null)?.id).toBe('a');
    expect(findMergeableLine(items, 'burger', [], null)).toBeNull();
  });

  it('never merges into a customised line or one with a note', () => {
    const items = [line('a', 'pizza', { modifiers: [{ id: 'no-onion' }] }), line('b', 'pizza', { notes: 'nut allergy' })];
    expect(findMergeableLine(items, 'pizza', [], null)).toBeNull();
  });

  it('never merges a tap that carries choices or a note', () => {
    const items = [line('a', 'pizza')];
    expect(findMergeableLine(items, 'pizza', ['extra-cheese'], null)).toBeNull();
    expect(findMergeableLine(items, 'pizza', [], 'well done')).toBeNull();
    // A blank note is no note.
    expect(findMergeableLine(items, 'pizza', [], '  ')?.id).toBe('a');
  });

  it('leaves deal lines alone and prefers the newest plain line', () => {
    const items = [line('a', 'coke'), line('d', 'coke', { parentOrderItemId: 'deal' }), line('c', 'coke', { comboId: 'combo' }), line('b', 'coke')];
    expect(findMergeableLine(items, 'coke', [], null)?.id).toBe('b');
  });
});

describe('addedLineId', () => {
  it('names the line that was not there before', () => {
    expect(addedLineId([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toBe('b');
    expect(addedLineId([{ id: 'a' }], [{ id: 'a' }])).toBeNull();
  });
});

describe('createSerialQueue', () => {
  it('runs jobs one at a time, in order, and reports busy', async () => {
    const busy: boolean[] = [];
    const run = createSerialQueue((b) => busy.push(b));
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start ${name}`);
        setTimeout(() => {
          running -= 1;
          log.push(`end ${name}`);
          resolve(name);
        }, ms);
      });
    const results = await Promise.all([run(job('a', 20)), run(job('b', 1)), run(job('c', 5))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(busy).toEqual([true, false]);
  });

  it('a failed job rejects for its caller but does not block the next', async () => {
    const run = createSerialQueue(() => {});
    const failed = run(() => Promise.reject(new Error('nope')));
    const next = run(() => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('nope');
    await expect(next).resolves.toBe('ok');
  });
});
