import { isLeaveOutChoice } from '@cheeseoclock/shared-types';

/**
 * Pure helpers behind the Menu screens' lists: what kind of choice group a
 * group is, which item a per-item group belongs to, and how to order groups
 * in an item's editor. No React — unit-tested in menuLists.test.ts.
 *
 * The imported menu names per-item groups "<kind> · <item>" (group names are
 * unique on the till): "Leave out · Fajita Pizza", "Extras · Burgers". With
 * 22 "Leave out · …" groups the flat list was unreadable.
 */

export type GroupKind = 'required' | 'leave-out' | 'extras';

export interface GroupLike {
  id: string;
  name: string;
  isRequired: boolean;
  minSelect: number;
  modifiers: ReadonlyArray<{ name: string }>;
}

export const GROUP_KIND_LABEL: Record<GroupKind, string> = {
  required: 'Must choose',
  'leave-out': 'Leave-outs',
  extras: 'Extras & add-ons',
};

/** Words before " · " that mark a per-item group; the item follows. */
const PER_ITEM_PREFIXES = ['leave out', 'extras', 'extra', 'add ons', 'add-ons'];

function splitName(name: string): { head: string; tail: string | null } {
  const i = name.indexOf(' · ');
  return i > 0 ? { head: name.slice(0, i).trim(), tail: name.slice(i + 3).trim() || null } : { head: name.trim(), tail: null };
}

/**
 * The item (or item family) a per-item group is for: "Leave out · Fajita
 * Pizza" → "Fajita Pizza", "Extras · Burgers" → "Burgers". Null for a shared
 * group ("Extra toppings", "Choose your dip", "Veggie Lovers · Choose 5 veggies").
 */
export function groupItemName(name: string): string | null {
  const { head, tail } = splitName(name);
  return tail && PER_ITEM_PREFIXES.includes(head.toLowerCase()) ? tail : null;
}

/**
 * A group the order cannot go without (a dip, a deal's pizzas, five veggies)
 * is "must choose"; a group of "No …" choices is a leave-out group; the rest
 * are extras the customer may add.
 */
export function modifierGroupKind(g: GroupLike): GroupKind {
  if (g.isRequired || g.minSelect > 0) return 'required';
  const head = splitName(g.name).head.toLowerCase();
  if (head === 'leave out' || head.startsWith('leave out')) return 'leave-out';
  if (g.modifiers.length > 0 && g.modifiers.every((m) => isLeaveOutChoice(m.name))) return 'leave-out';
  return 'extras';
}

/** What a person might type to find a group: its name and its options. */
export function modifierGroupSearchText(g: GroupLike): string {
  return `${g.name} ${GROUP_KIND_LABEL[modifierGroupKind(g)]} ${g.modifiers.map((m) => m.name).join(' ')}`;
}

export interface GroupSection<G extends GroupLike> {
  id: 'attached' | 'this-item' | GroupKind | 'other-items';
  title: string;
  groups: G[];
  /** Start folded away (other items' leave-outs). */
  collapsed: boolean;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * An item's editor lists every group, but in the order a manager needs it:
 * what is on the item now, groups made for this item, shared must-choose and
 * extras groups, and — folded away — the leave-outs made for other items.
 */
export function sectionGroupsForItem<G extends GroupLike>(
  groups: readonly G[],
  attachedIds: ReadonlySet<string>,
  itemName: string,
): GroupSection<G>[] {
  const attached: G[] = [];
  const thisItem: G[] = [];
  const required: G[] = [];
  const extras: G[] = [];
  const leaveOuts: G[] = [];
  const otherItems: G[] = [];
  for (const g of groups) {
    const forItem = groupItemName(g.name);
    if (attachedIds.has(g.id)) attached.push(g);
    else if (forItem && itemName.trim() && sameName(forItem, itemName)) thisItem.push(g);
    else if (forItem) otherItems.push(g);
    else {
      const kind = modifierGroupKind(g);
      if (kind === 'required') required.push(g);
      else if (kind === 'leave-out') leaveOuts.push(g);
      else extras.push(g);
    }
  }
  const sections: GroupSection<G>[] = [
    { id: 'attached', title: 'On this item', groups: attached, collapsed: false },
    { id: 'this-item', title: 'Made for this item', groups: thisItem, collapsed: false },
    { id: 'required', title: GROUP_KIND_LABEL.required, groups: required, collapsed: false },
    { id: 'extras', title: GROUP_KIND_LABEL.extras, groups: extras, collapsed: false },
    { id: 'leave-out', title: GROUP_KIND_LABEL['leave-out'], groups: leaveOuts, collapsed: false },
    { id: 'other-items', title: 'Made for other items', groups: otherItems, collapsed: true },
  ];
  return sections.filter((s) => s.groups.length > 0);
}
