/**
 * Row images: what one till sends another for a business row.
 *
 * A row image is the whole row as stored, one key per column, the column name
 * in camelCase (`rate_bps` → `rateBps`), plus a marker key. Every replicable
 * table is sent this way, both by the live queue (every business write) and by
 * the one-off "send everything" after the queue was cleared. The receiver
 * writes the row back from the image column by column, so no table needs a
 * hand-written handler and nothing is lost on the way (the older domain-shaped
 * payloads could not rebuild an order line or an ingredient).
 *
 * No driver code here: the column lists come from the live schema on each side.
 */

/** Marks a payload as a row image. The value is the image format version. */
export const ROW_IMAGE_KEY = '__rowImage';
export const ROW_IMAGE_VERSION = 1;

/** Written by each till about itself; never sent. */
export const RECEIVER_OWNED_COLUMNS: ReadonlySet<string> = new Set(['synced_at']);

/**
 * Columns that never leave the till that wrote them. A user's PIN hash stays
 * on the till where the PIN was set; the other till gets the user (orders
 * point at them) but not their PIN.
 */
export const LOCAL_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['pin_hash'],
};

/**
 * Running totals each till keeps for its own sales. The other till's value is
 * taken only when the row is new here; after that this till's count stands
 * (the other till's sales arrive as their own stock movement rows).
 */
export const RECEIVER_KEEPS_ON_UPDATE: Readonly<Record<string, readonly string[]>> = {
  ingredients: ['current_qty'],
};

/** snake_case column name → the image key (`tax_rate_bps_snapshot` → `taxRateBpsSnapshot`). */
export function columnKey(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export type RowImage = { [ROW_IMAGE_KEY]: number; id: string } & Record<string, unknown>;

export function isRowImage(p: unknown): p is RowImage {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return false;
  const r = p as Record<string, unknown>;
  return r[ROW_IMAGE_KEY] === ROW_IMAGE_VERSION && typeof r['id'] === 'string';
}

export function isLocalOnlyColumn(table: string, column: string): boolean {
  return LOCAL_ONLY_COLUMNS[table]?.includes(column) ?? false;
}
