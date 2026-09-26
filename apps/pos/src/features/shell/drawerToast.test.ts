import { describe, expect, it } from 'vitest';
import type { DrawerOpenResult } from '@cheeseoclock/shared-types';
import { drawerReason, drawerResultToast } from './drawerToast';

const result = (over: Partial<DrawerOpenResult>): DrawerOpenResult => ({
  id: 'd1',
  opened: true,
  unsure: false,
  noPrinter: false,
  message: null,
  ...over,
});

describe('what the counter is told after Open drawer', () => {
  it('opened', () => {
    expect(drawerResultToast(result({}))).toEqual({ title: 'Drawer opened', variant: 'success' });
  });

  it('no printer: never "Drawer opened", even though the file printer took it', () => {
    const t = drawerResultToast(result({ opened: true, noPrinter: true }));
    expect(t.title).toBe('No printer is set up — nothing opened');
    expect(t.variant).toBe('info');
  });

  it('did not open: use the key, with the reason', () => {
    expect(drawerResultToast(result({ opened: false, message: "The printer didn't answer." }))).toEqual({
      title: 'Cash drawer did not open — use the key',
      description: "The printer didn't answer.",
      variant: 'warning',
    });
  });

  it('may have opened: check it', () => {
    const t = drawerResultToast(result({ opened: false, unsure: true, message: 'Check the drawer.' }));
    expect(t.title).toBe('Cash drawer may not have opened — check it');
    expect(t.variant).toBe('warning');
  });
});

describe('the reason saved with a no-sale open', () => {
  it('is the chip, or what was typed for Other, or nothing', () => {
    expect(drawerReason(null, 'ignored')).toBeNull();
    expect(drawerReason('Change', 'ignored')).toBe('Change');
    expect(drawerReason('Check notes', '')).toBe('Check notes');
    expect(drawerReason('Other', '  float   top-up ')).toBe('float top-up');
    expect(drawerReason('Other', '   ')).toBe('Other');
    expect(drawerReason('Other', 'x'.repeat(200))).toHaveLength(80);
  });
});
