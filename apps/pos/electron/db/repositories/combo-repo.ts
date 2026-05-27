import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import type {
  Combo,
  ComboComponent,
  ComboComponentChoice,
  ComboSelectionType,
} from '@cheeseoclock/shared-types';

// -----------------------------------------------------------------------------
// combos
// -----------------------------------------------------------------------------

interface ComboRow {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
  device_id: string;
  version: number;
}

function rowToCombo(row: ComboRow): Combo {
  return {
    id: row.id as Combo['id'],
    name: row.name,
    description: row.description,
    priceCents: row.price_cents as Combo['priceCents'],
    isActive: toBool(row.is_active),
  };
}

const COMBO_SELECT = `
  id, name, description, price_cents, is_active,
  created_at, updated_at, synced_at, deleted_at, device_id, version
`;

export function listCombos(db: AppDatabase, opts?: { activeOnly?: boolean }): Combo[] {
  const where = opts?.activeOnly
    ? 'WHERE deleted_at IS NULL AND is_active = 1'
    : 'WHERE deleted_at IS NULL';
  const rows = db
    .prepare(`SELECT ${COMBO_SELECT} FROM combos ${where} ORDER BY name`)
    .all() as ComboRow[];
  return rows.map(rowToCombo);
}

export function findCombo(db: AppDatabase, id: string): Combo | null {
  const row = db
    .prepare(`SELECT ${COMBO_SELECT} FROM combos WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as ComboRow | undefined;
  return row ? rowToCombo(row) : null;
}

export interface CreateComboInput {
  name: string;
  description?: string | null;
  priceCents: number;
  isActive?: boolean;
}

export function createCombo(db: AppDatabase, input: CreateComboInput, actor: Actor): Combo {
  const id = uuidv7();
  const now = nowIso();
  const combo: Combo = {
    id: id as Combo['id'],
    name: input.name,
    description: input.description ?? null,
    priceCents: input.priceCents as Combo['priceCents'],
    isActive: input.isActive ?? true,
  };
  writeWithSync({
    db,
    entityType: 'combos',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: combo,
    writeRow: () => {
      db.prepare(
        `INSERT INTO combos (id, name, description, price_cents, is_active, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        combo.name,
        combo.description,
        combo.priceCents,
        fromBool(combo.isActive),
        now,
        now,
        actor.deviceId,
      );
    },
  });
  return combo;
}

export interface UpdateComboInput {
  id: string;
  name?: string;
  description?: string | null;
  priceCents?: number;
  isActive?: boolean;
}

export function updateCombo(db: AppDatabase, input: UpdateComboInput, actor: Actor): Combo {
  const row = db
    .prepare(`SELECT ${COMBO_SELECT} FROM combos WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as ComboRow | undefined;
  if (!row) throw new Error('Combo not found');

  const before = rowToCombo(row);
  const after: Combo = {
    ...before,
    name: input.name ?? before.name,
    description: input.description !== undefined ? input.description : before.description,
    priceCents: (input.priceCents ?? before.priceCents) as Combo['priceCents'],
    isActive: input.isActive ?? before.isActive,
  };
  const now = nowIso();

  writeWithSync({
    db,
    entityType: 'combos',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE combos SET name = ?, description = ?, price_cents = ?, is_active = ?,
                            updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(
        after.name,
        after.description,
        after.priceCents,
        fromBool(after.isActive),
        now,
        input.id,
      );
    },
  });
  return after;
}

export function deleteCombo(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT ${COMBO_SELECT} FROM combos WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as ComboRow | undefined;
  if (!row) throw new Error('Combo not found');
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'combos',
    entityId: id,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToCombo(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE combos SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
    },
  });
}

// -----------------------------------------------------------------------------
// combo_components + combo_component_choices — manipulated together as a
// nested aggregate to keep callers from having to coordinate three tables.
// -----------------------------------------------------------------------------

interface CompRow {
  id: string;
  combo_id: string;
  slot_name: string;
  selection_type: ComboSelectionType;
  sort_order: number;
}

interface ChoiceRow {
  id: string;
  combo_component_id: string;
  menu_item_id: string;
  price_delta_cents: number;
}

export interface ComboComponentWithChoices extends ComboComponent {
  choices: ComboComponentChoice[];
}

export function listComboComponents(
  db: AppDatabase,
  comboId: string,
): ComboComponentWithChoices[] {
  const components = db
    .prepare(
      `SELECT id, combo_id, slot_name, selection_type, sort_order
         FROM combo_components
        WHERE combo_id = ? AND deleted_at IS NULL
        ORDER BY sort_order`,
    )
    .all(comboId) as CompRow[];

  if (components.length === 0) return [];

  const placeholders = components.map(() => '?').join(',');
  const choices = db
    .prepare(
      `SELECT id, combo_component_id, menu_item_id, price_delta_cents
         FROM combo_component_choices
        WHERE combo_component_id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .all(...components.map((c) => c.id)) as ChoiceRow[];

  const choicesByComp = new Map<string, ChoiceRow[]>();
  for (const c of choices) {
    const arr = choicesByComp.get(c.combo_component_id) ?? [];
    arr.push(c);
    choicesByComp.set(c.combo_component_id, arr);
  }

  return components.map<ComboComponentWithChoices>((comp) => ({
    id: comp.id as ComboComponent['id'],
    comboId: comp.combo_id as ComboComponent['comboId'],
    slotName: comp.slot_name,
    selectionType: comp.selection_type,
    sortOrder: comp.sort_order,
    choices: (choicesByComp.get(comp.id) ?? []).map((c) => ({
      id: c.id as ComboComponentChoice['id'],
      comboComponentId: c.combo_component_id as ComboComponentChoice['comboComponentId'],
      menuItemId: c.menu_item_id as ComboComponentChoice['menuItemId'],
      priceDeltaCents: c.price_delta_cents as ComboComponentChoice['priceDeltaCents'],
    })),
  }));
}

export interface SetComboStructureInput {
  comboId: string;
  components: Array<{
    slotName: string;
    selectionType: ComboSelectionType;
    sortOrder: number;
    choices: Array<{ menuItemId: string; priceDeltaCents: number }>;
  }>;
}

/**
 * Replace the entire component structure of a combo. Old components and choices
 * are soft-deleted; new ones inserted. One transaction.
 */
export function setComboStructure(
  db: AppDatabase,
  input: SetComboStructureInput,
  actor: Actor,
): void {
  const now = nowIso();

  const tx = db.transaction(() => {
    // Soft-delete all existing components + their choices
    const oldComps = db
      .prepare(`SELECT id FROM combo_components WHERE combo_id = ? AND deleted_at IS NULL`)
      .all(input.comboId) as Array<{ id: string }>;

    for (const oc of oldComps) {
      db.prepare(
        `UPDATE combo_component_choices SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE combo_component_id = ? AND deleted_at IS NULL`,
      ).run(now, now, oc.id);
      db.prepare(
        `UPDATE combo_components SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, oc.id);
      enqueueSync(db, {
        entityType: 'combo_components',
        entityId: oc.id,
        op: 'delete',
        payload: { id: oc.id, deletedAt: now },
      });
    }

    // Insert fresh components + choices
    for (const comp of input.components) {
      const compId = uuidv7();
      db.prepare(
        `INSERT INTO combo_components
           (id, combo_id, slot_name, selection_type, sort_order,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(compId, input.comboId, comp.slotName, comp.selectionType, comp.sortOrder, now, now, actor.deviceId);
      enqueueSync(db, {
        entityType: 'combo_components',
        entityId: compId,
        op: 'upsert',
        payload: { id: compId, comboId: input.comboId, ...comp },
      });

      for (const choice of comp.choices) {
        const choiceId = uuidv7();
        db.prepare(
          `INSERT INTO combo_component_choices
             (id, combo_component_id, menu_item_id, price_delta_cents,
              created_at, updated_at, device_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(choiceId, compId, choice.menuItemId, choice.priceDeltaCents, now, now, actor.deviceId);
        enqueueSync(db, {
          entityType: 'combo_component_choices',
          entityId: choiceId,
          op: 'upsert',
          payload: { id: choiceId, comboComponentId: compId, ...choice },
        });
      }
    }

    writeAudit(db, {
      entityType: 'combos',
      entityId: input.comboId,
      action: 'restructure',
      actorUserId: actor.userId,
      before: null,
      after: input,
    });
  });
  tx();
}
