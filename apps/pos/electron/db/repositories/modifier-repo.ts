import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import type {
  ModifierGroup,
  Modifier,
  ModifierSelectionType,
} from '@cheeseoclock/shared-types';

// -----------------------------------------------------------------------------
// modifier_groups
// -----------------------------------------------------------------------------

interface GroupRow {
  id: string;
  name: string;
  selection_type: ModifierSelectionType;
  min_select: number;
  max_select: number;
  is_required: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
  device_id: string;
  version: number;
}

function rowToGroup(row: GroupRow): ModifierGroup {
  return {
    id: row.id as ModifierGroup['id'],
    name: row.name,
    selectionType: row.selection_type,
    minSelect: row.min_select,
    maxSelect: row.max_select,
    isRequired: toBool(row.is_required),
  };
}

const GROUP_SELECT = `
  id, name, selection_type, min_select, max_select, is_required,
  created_at, updated_at, synced_at, deleted_at, device_id, version
`;

export function listModifierGroups(db: AppDatabase): ModifierGroup[] {
  const rows = db
    .prepare(
      `SELECT ${GROUP_SELECT} FROM modifier_groups WHERE deleted_at IS NULL ORDER BY name`,
    )
    .all() as GroupRow[];
  return rows.map(rowToGroup);
}

export function findModifierGroup(db: AppDatabase, id: string): ModifierGroup | null {
  const row = db
    .prepare(`SELECT ${GROUP_SELECT} FROM modifier_groups WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as GroupRow | undefined;
  return row ? rowToGroup(row) : null;
}

export interface CreateModifierGroupInput {
  name: string;
  selectionType: ModifierSelectionType;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
}

export function createModifierGroup(
  db: AppDatabase,
  input: CreateModifierGroupInput,
  actor: Actor,
): ModifierGroup {
  const id = uuidv7();
  const now = nowIso();
  const group: ModifierGroup = {
    id: id as ModifierGroup['id'],
    name: input.name,
    selectionType: input.selectionType,
    minSelect: input.minSelect,
    maxSelect: input.maxSelect,
    isRequired: input.isRequired,
  };
  writeWithSync({
    db,
    entityType: 'modifier_groups',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: group,
    writeRow: () => {
      db.prepare(
        `INSERT INTO modifier_groups
           (id, name, selection_type, min_select, max_select, is_required,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        input.name,
        input.selectionType,
        input.minSelect,
        input.maxSelect,
        fromBool(input.isRequired),
        now,
        now,
        actor.deviceId,
      );
    },
  });
  return group;
}

export interface UpdateModifierGroupInput extends Partial<CreateModifierGroupInput> {
  id: string;
}

export function updateModifierGroup(
  db: AppDatabase,
  input: UpdateModifierGroupInput,
  actor: Actor,
): ModifierGroup {
  const row = db
    .prepare(`SELECT ${GROUP_SELECT} FROM modifier_groups WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as GroupRow | undefined;
  if (!row) throw new Error('Modifier group not found');

  const before = rowToGroup(row);
  const after: ModifierGroup = {
    ...before,
    name: input.name ?? before.name,
    selectionType: input.selectionType ?? before.selectionType,
    minSelect: input.minSelect ?? before.minSelect,
    maxSelect: input.maxSelect ?? before.maxSelect,
    isRequired: input.isRequired ?? before.isRequired,
  };
  const now = nowIso();

  writeWithSync({
    db,
    entityType: 'modifier_groups',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE modifier_groups
            SET name = ?, selection_type = ?, min_select = ?, max_select = ?, is_required = ?,
                updated_at = ?, version = version + 1
          WHERE id = ?`,
      ).run(
        after.name,
        after.selectionType,
        after.minSelect,
        after.maxSelect,
        fromBool(after.isRequired),
        now,
        input.id,
      );
    },
  });
  return after;
}

export function deleteModifierGroup(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT ${GROUP_SELECT} FROM modifier_groups WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as GroupRow | undefined;
  if (!row) throw new Error('Modifier group not found');

  const usage = db
    .prepare(
      `SELECT COUNT(*) AS n FROM menu_item_modifier_groups WHERE modifier_group_id = ? AND deleted_at IS NULL`,
    )
    .get(id) as { n: number };
  if (usage.n > 0) {
    throw new Error(`Modifier group is attached to ${usage.n} menu items — detach first`);
  }

  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'modifier_groups',
    entityId: id,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToGroup(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE modifier_groups SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
    },
  });
}

// -----------------------------------------------------------------------------
// modifiers (children of a group)
// -----------------------------------------------------------------------------

interface ModRow {
  id: string;
  modifier_group_id: string;
  name: string;
  price_delta_cents: number;
  is_default: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
  device_id: string;
  version: number;
}

function rowToModifier(row: ModRow): Modifier {
  return {
    id: row.id as Modifier['id'],
    modifierGroupId: row.modifier_group_id as Modifier['modifierGroupId'],
    name: row.name,
    priceDeltaCents: row.price_delta_cents as Modifier['priceDeltaCents'],
    isDefault: toBool(row.is_default),
    sortOrder: row.sort_order,
  };
}

const MOD_SELECT = `
  id, modifier_group_id, name, price_delta_cents, is_default, sort_order,
  created_at, updated_at, synced_at, deleted_at, device_id, version
`;

export function listModifiersByGroup(db: AppDatabase, groupId: string): Modifier[] {
  const rows = db
    .prepare(
      `SELECT ${MOD_SELECT} FROM modifiers
        WHERE modifier_group_id = ? AND deleted_at IS NULL
        ORDER BY sort_order, name`,
    )
    .all(groupId) as ModRow[];
  return rows.map(rowToModifier);
}

export interface CreateModifierInput {
  modifierGroupId: string;
  name: string;
  priceDeltaCents: number;
  isDefault?: boolean;
  sortOrder?: number;
}

export function createModifier(
  db: AppDatabase,
  input: CreateModifierInput,
  actor: Actor,
): Modifier {
  const id = uuidv7();
  const now = nowIso();
  const mod: Modifier = {
    id: id as Modifier['id'],
    modifierGroupId: input.modifierGroupId as Modifier['modifierGroupId'],
    name: input.name,
    priceDeltaCents: input.priceDeltaCents as Modifier['priceDeltaCents'],
    isDefault: input.isDefault ?? false,
    sortOrder: input.sortOrder ?? 0,
  };
  writeWithSync({
    db,
    entityType: 'modifiers',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: mod,
    writeRow: () => {
      db.prepare(
        `INSERT INTO modifiers
           (id, modifier_group_id, name, price_delta_cents, is_default, sort_order,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        mod.modifierGroupId,
        mod.name,
        mod.priceDeltaCents,
        fromBool(mod.isDefault),
        mod.sortOrder,
        now,
        now,
        actor.deviceId,
      );
    },
  });
  return mod;
}

export interface UpdateModifierInput {
  id: string;
  name?: string;
  priceDeltaCents?: number;
  isDefault?: boolean;
  sortOrder?: number;
}

export function updateModifier(
  db: AppDatabase,
  input: UpdateModifierInput,
  actor: Actor,
): Modifier {
  const row = db
    .prepare(`SELECT ${MOD_SELECT} FROM modifiers WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as ModRow | undefined;
  if (!row) throw new Error('Modifier not found');

  const before = rowToModifier(row);
  const after: Modifier = {
    ...before,
    name: input.name ?? before.name,
    priceDeltaCents: (input.priceDeltaCents ?? before.priceDeltaCents) as Modifier['priceDeltaCents'],
    isDefault: input.isDefault ?? before.isDefault,
    sortOrder: input.sortOrder ?? before.sortOrder,
  };
  const now = nowIso();

  writeWithSync({
    db,
    entityType: 'modifiers',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE modifiers
            SET name = ?, price_delta_cents = ?, is_default = ?, sort_order = ?,
                updated_at = ?, version = version + 1
          WHERE id = ?`,
      ).run(
        after.name,
        after.priceDeltaCents,
        fromBool(after.isDefault),
        after.sortOrder,
        now,
        input.id,
      );
    },
  });
  return after;
}

export function deleteModifier(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT ${MOD_SELECT} FROM modifiers WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as ModRow | undefined;
  if (!row) throw new Error('Modifier not found');
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'modifiers',
    entityId: id,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToModifier(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE modifiers SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
    },
  });
}

// -----------------------------------------------------------------------------
// menu_item_modifier_groups (M:N junction)
// -----------------------------------------------------------------------------

export function listModifierGroupsForItem(
  db: AppDatabase,
  menuItemId: string,
): Array<ModifierGroup & { sortOrder: number; junctionId: string }> {
  const rows = db
    .prepare(
      `SELECT j.id AS junction_id, j.sort_order, ${GROUP_SELECT
        .split(',')
        .map((c) => `mg.${c.trim()}`)
        .join(', ')}
         FROM menu_item_modifier_groups j
         JOIN modifier_groups mg ON mg.id = j.modifier_group_id
        WHERE j.menu_item_id = ? AND j.deleted_at IS NULL AND mg.deleted_at IS NULL
        ORDER BY j.sort_order`,
    )
    .all(menuItemId) as Array<GroupRow & { junction_id: string; sort_order: number }>;
  return rows.map((row) => ({
    ...rowToGroup(row),
    sortOrder: row.sort_order,
    junctionId: row.junction_id,
  }));
}

/**
 * Replace the set of modifier groups attached to an item. Computes diff vs
 * current state and emits per-row create/update/delete sync events so the
 * change is replicable. All in one transaction.
 */
export function setItemModifierGroups(
  db: AppDatabase,
  menuItemId: string,
  desired: Array<{ modifierGroupId: string; sortOrder: number }>,
  actor: Actor,
): void {
  const current = db
    .prepare(
      `SELECT id, modifier_group_id, sort_order
         FROM menu_item_modifier_groups
        WHERE menu_item_id = ? AND deleted_at IS NULL`,
    )
    .all(menuItemId) as Array<{ id: string; modifier_group_id: string; sort_order: number }>;

  const currentByGroup = new Map(current.map((r) => [r.modifier_group_id, r]));
  const desiredByGroup = new Map(desired.map((d) => [d.modifierGroupId, d]));
  const now = nowIso();

  const tx = db.transaction(() => {
    // Delete junctions whose groups are no longer desired
    for (const row of current) {
      if (!desiredByGroup.has(row.modifier_group_id)) {
        db.prepare(
          `UPDATE menu_item_modifier_groups
              SET deleted_at = ?, updated_at = ?, version = version + 1
            WHERE id = ?`,
        ).run(now, now, row.id);
        // sync + audit emitted per junction
        emitJunctionEvent(db, actor, row.id, 'delete', null);
      }
    }
    // Insert / update junctions for desired groups
    for (const want of desired) {
      const existing = currentByGroup.get(want.modifierGroupId);
      if (existing) {
        if (existing.sort_order !== want.sortOrder) {
          db.prepare(
            `UPDATE menu_item_modifier_groups
                SET sort_order = ?, updated_at = ?, version = version + 1
              WHERE id = ?`,
          ).run(want.sortOrder, now, existing.id);
          emitJunctionEvent(db, actor, existing.id, 'upsert', {
            id: existing.id,
            menuItemId,
            modifierGroupId: want.modifierGroupId,
            sortOrder: want.sortOrder,
          });
        }
      } else {
        const id = uuidv7();
        db.prepare(
          `INSERT INTO menu_item_modifier_groups
             (id, menu_item_id, modifier_group_id, sort_order,
              created_at, updated_at, device_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, menuItemId, want.modifierGroupId, want.sortOrder, now, now, actor.deviceId);
        emitJunctionEvent(db, actor, id, 'upsert', {
          id,
          menuItemId,
          modifierGroupId: want.modifierGroupId,
          sortOrder: want.sortOrder,
        });
      }
    }
  });
  tx();
}

function emitJunctionEvent(
  db: AppDatabase,
  actor: Actor,
  junctionId: string,
  op: 'upsert' | 'delete',
  payload: unknown,
): void {
  // Inline enqueue + audit because we're already inside the parent transaction
  // (calling writeWithSync would nest a transaction).
  enqueueSync(db, {
    entityType: 'menu_item_modifier_groups',
    entityId: junctionId,
    op,
    payload: payload ?? { id: junctionId, deletedAt: nowIso() },
  });
  writeAudit(db, {
    entityType: 'menu_item_modifier_groups',
    entityId: junctionId,
    action: op === 'delete' ? 'delete' : 'update',
    actorUserId: actor.userId,
    before: null,
    after: payload,
  });
}
