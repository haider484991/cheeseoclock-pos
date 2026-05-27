import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';

export type TableStatus = 'free' | 'occupied' | 'reserved' | 'cleaning';

export interface FloorSection {
  id: string;
  name: string;
  sortOrder: number;
}

export interface RestaurantTable {
  id: string;
  floorSectionId: string;
  label: string;
  capacity: number;
  status: TableStatus;
  currentOrderId: string | null;
}

interface SectionRow {
  id: string;
  name: string;
  sort_order: number;
}

interface TableRow {
  id: string;
  floor_section_id: string;
  label: string;
  capacity: number;
  status: TableStatus;
  current_order_id: string | null;
}

export function listFloorSections(db: AppDatabase): FloorSection[] {
  const rows = db
    .prepare(
      `SELECT id, name, sort_order FROM floor_sections WHERE deleted_at IS NULL ORDER BY sort_order, name`,
    )
    .all() as SectionRow[];
  return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order }));
}

export function listTables(db: AppDatabase, sectionId?: string): RestaurantTable[] {
  const where = sectionId
    ? 'WHERE deleted_at IS NULL AND floor_section_id = ?'
    : 'WHERE deleted_at IS NULL';
  const stmt = db.prepare(
    `SELECT id, floor_section_id, label, capacity, status, current_order_id
       FROM tables ${where} ORDER BY label`,
  );
  const rows = (sectionId ? stmt.all(sectionId) : stmt.all()) as TableRow[];
  return rows.map((r) => ({
    id: r.id,
    floorSectionId: r.floor_section_id,
    label: r.label,
    capacity: r.capacity,
    status: r.status,
    currentOrderId: r.current_order_id,
  }));
}

export function createFloorSection(
  db: AppDatabase,
  input: { name: string; sortOrder: number },
  actor: Actor,
): FloorSection {
  const id = uuidv7();
  const now = nowIso();
  const section: FloorSection = { id, name: input.name, sortOrder: input.sortOrder };
  writeWithSync({
    db,
    entityType: 'floor_sections',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: section,
    writeRow: () => {
      db.prepare(
        `INSERT INTO floor_sections (id, name, sort_order, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).run(id, input.name, input.sortOrder, now, now, actor.deviceId);
    },
  });
  return section;
}

export function createTable(
  db: AppDatabase,
  input: { floorSectionId: string; label: string; capacity: number },
  actor: Actor,
): RestaurantTable {
  const id = uuidv7();
  const now = nowIso();
  const table: RestaurantTable = {
    id,
    floorSectionId: input.floorSectionId,
    label: input.label,
    capacity: input.capacity,
    status: 'free',
    currentOrderId: null,
  };
  writeWithSync({
    db,
    entityType: 'tables',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: table,
    writeRow: () => {
      db.prepare(
        `INSERT INTO tables
           (id, floor_section_id, label, capacity, status,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, 'free', ?, ?, ?, 1)`,
      ).run(id, input.floorSectionId, input.label, input.capacity, now, now, actor.deviceId);
    },
  });
  return table;
}

export function setTableStatus(
  db: AppDatabase,
  id: string,
  status: TableStatus,
  currentOrderId: string | null,
  actor: Actor,
): void {
  const row = db
    .prepare(
      `SELECT id, floor_section_id, label, capacity, status, current_order_id
         FROM tables WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as TableRow | undefined;
  if (!row) throw new Error('Table not found');

  const before: RestaurantTable = {
    id: row.id,
    floorSectionId: row.floor_section_id,
    label: row.label,
    capacity: row.capacity,
    status: row.status,
    currentOrderId: row.current_order_id,
  };
  const after: RestaurantTable = { ...before, status, currentOrderId };
  const now = nowIso();

  writeWithSync({
    db,
    entityType: 'tables',
    entityId: id,
    op: 'upsert',
    action: 'status',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE tables SET status = ?, current_order_id = ?, updated_at = ?, version = version + 1
          WHERE id = ?`,
      ).run(status, currentOrderId, now, id);
    },
  });
}
