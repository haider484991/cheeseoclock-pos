/**
 * The rule for leaving a delivery area out of a Save: an area a saved address
 * still names (by name or spelling) can only be switched off; one no address
 * uses may go. No database. Every area is made up.
 */
import { describe, expect, it } from 'vitest';
import { zonesSaveProblem } from './delivery-zones-repo.js';

const zone = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases });
const saved = [zone('a', 'Test Phase 1', ['phase one']), zone('b', 'Test Phase 2'), zone('c', 'Test Block 3', ['blk 3'])];

describe('zonesSaveProblem', () => {
  it('keeping every area is never a problem', () => {
    expect(zonesSaveProblem(saved, saved, new Set(['test phase 1']))).toBeNull();
  });

  it('an area no address uses may be left out', () => {
    expect(zonesSaveProblem(saved, [saved[0]!, saved[2]!], new Set(['test phase 1', 'test block 3']))).toBeNull();
    expect(zonesSaveProblem(saved, [], new Set())).toBeNull();
  });

  it('an area a saved address names stays, and the message names it', () => {
    const problem = zonesSaveProblem(saved, [saved[0]!, saved[2]!], new Set(['test phase 2']));
    expect(problem).toMatch(/Test Phase 2 can’t be removed/);
  });

  it('a spelling on an address counts as use, whatever its case or spaces', () => {
    expect(zonesSaveProblem(saved, [saved[1]!, saved[2]!], new Set(['phase one']))).toMatch(/Test Phase 1/);
    expect(zonesSaveProblem(saved, [saved[0]!, saved[1]!], new Set(['blk 3']))).toMatch(/Test Block 3/);
    expect(zonesSaveProblem(saved, [saved[0]!, saved[1]!], new Set(['BLK 3']))).toBeNull();
  });
});
