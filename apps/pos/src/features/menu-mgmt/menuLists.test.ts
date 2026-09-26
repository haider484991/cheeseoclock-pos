import { describe, expect, it } from 'vitest';
import {
  groupItemName,
  modifierGroupKind,
  modifierGroupSearchText,
  sectionGroupsForItem,
  type GroupLike,
} from './menuLists';

const group = (id: string, name: string, over: Partial<GroupLike> = {}, options: string[] = []): GroupLike => ({
  id,
  name,
  isRequired: false,
  minSelect: 0,
  modifiers: options.map((o) => ({ name: o })),
  ...over,
});

// The shapes the imported menu actually has.
const dip = group('dip', 'Choose your dip', { isRequired: true, minSelect: 1 }, ['Garlic Mayo', 'Ranch']);
const veggies = group('veg', 'Veggie Lovers · Choose 5 veggies', { minSelect: 5 }, ['Onion', 'Capsicum']);
const deal = group('deal', 'Deal: Large pizza', { isRequired: true, minSelect: 1 });
const toppings = group('top', 'Extra toppings', {}, ['Extra cheese', 'Jalapeño']);
const burgerExtras = group('bx', 'Extras · Burgers', {}, ['Add cheese slice']);
const dipsSide = group('ds', 'Dips on the side', {}, ['Garlic Mayo']);
const loFajita = group('lf', 'Leave out · Fajita Pizza', {}, ['No onion', 'No capsicum']);
const loStar = group('ls', 'Leave out · Cheesy Star', {}, ['No jalapeño']);
const handMade = group('hm', 'No sauce please', {}, ['No sauce', 'No oregano']);

describe('modifierGroupKind', () => {
  it('calls a group the order cannot go without "must choose"', () => {
    expect(modifierGroupKind(dip)).toBe('required');
    expect(modifierGroupKind(veggies)).toBe('required');
    expect(modifierGroupKind(deal)).toBe('required');
  });

  it('spots leave-out groups by name or by their "No …" choices', () => {
    expect(modifierGroupKind(loFajita)).toBe('leave-out');
    expect(modifierGroupKind(handMade)).toBe('leave-out');
  });

  it('files everything else under extras', () => {
    expect(modifierGroupKind(toppings)).toBe('extras');
    expect(modifierGroupKind(burgerExtras)).toBe('extras');
    expect(modifierGroupKind(dipsSide)).toBe('extras');
    expect(modifierGroupKind(group('empty', 'New group'))).toBe('extras');
  });
});

describe('groupItemName', () => {
  it('reads the item off a per-item group', () => {
    expect(groupItemName('Leave out · Fajita Pizza')).toBe('Fajita Pizza');
    expect(groupItemName('Extras · Burgers')).toBe('Burgers');
  });

  it('leaves shared groups alone, even with a " · " in the name', () => {
    expect(groupItemName('Veggie Lovers · Choose 5 veggies')).toBeNull();
    expect(groupItemName('Extra toppings')).toBeNull();
    expect(groupItemName('Choose your dip')).toBeNull();
  });
});

describe('modifierGroupSearchText', () => {
  it('lets a manager find a group by one of its options', () => {
    expect(modifierGroupSearchText(loFajita)).toContain('No capsicum');
    expect(modifierGroupSearchText(loFajita)).toContain('Leave-outs');
  });
});

describe('sectionGroupsForItem', () => {
  const all = [dip, veggies, deal, toppings, burgerExtras, dipsSide, loFajita, loStar, handMade];
  const ids = (sections: ReturnType<typeof sectionGroupsForItem<GroupLike>>) =>
    Object.fromEntries(sections.map((s) => [s.id, s.groups.map((g) => g.id)]));

  it('puts what is on the item first and folds other items’ leave-outs away', () => {
    const sections = sectionGroupsForItem(all, new Set(['lf', 'top']), 'Fajita Pizza');
    expect(sections[0]?.id).toBe('attached');
    expect(ids(sections)).toEqual({
      attached: ['top', 'lf'],
      required: ['dip', 'veg', 'deal'],
      extras: ['ds'],
      'leave-out': ['hm'],
      'other-items': ['bx', 'ls'],
    });
    expect(sections.find((s) => s.id === 'other-items')?.collapsed).toBe(true);
  });

  it('offers the groups made for this item before the rest', () => {
    const sections = sectionGroupsForItem(all, new Set(), 'cheesy star');
    expect(sections[0]).toMatchObject({ id: 'this-item', groups: [loStar] });
  });

  it('never returns an empty section', () => {
    expect(sectionGroupsForItem([], new Set(), 'x')).toEqual([]);
  });
});
