# CheeseOclock — Conventions

This monorepo is the CheeseOclock Point-of-Sale (Electron desktop) + online ordering website (Next.js). The plan lives at `C:\Users\glh_0\.claude\plans\i-want-to-create-generic-flurry.md`.

The rules below are **non-negotiable** — breaking any of them silently breaks sync-readiness, FBR queueing, or audit accuracy. If a task seems to require breaking one, raise it instead of working around it.

## Monorepo

- **pnpm workspaces + Turborepo**. Use `pnpm` only — never `npm` or `yarn` (lockfile + native-build assumptions).
- **Package scope**: `@cheeseoclock/<name>`. Apps in `apps/`, libs in `packages/`, network services in `services/`.
- **Interface vs implementation**: every adapter (`PrinterAdapter`, `FbrAdapter`, `SyncAdapter`) has its **interface** in `packages/*-core` and its **implementation** in `apps/pos/electron/adapters/*`. Never put hardware/network code in a `packages/*-core` package.

## TypeScript

- `strict: true` and `noUncheckedIndexedAccess: true` everywhere. Inherits from `tsconfig.base.json`.
- No `any` without a `// FIXME(any): <reason>` line. CI lint will flag.
- Domain types live in `packages/shared-types`. Validation schemas (Zod) in `packages/shared-schemas`. One Zod schema → derives the TS type; never define both by hand.

## Database (SQLite via better-sqlite3)

- **Migrations only.** All schema changes go through numbered SQL files in `apps/pos/electron/db/migrations/`. Never edit a committed migration. Never run ad-hoc `ALTER TABLE`. Run migrations on every app boot via umzug.
- **UUID v7 ids.** No `INTEGER PRIMARY KEY AUTOINCREMENT` on replicable tables — multi-device safety + sortability.
- **All money in cents (`INTEGER`).** No `REAL`. No floating-point currency. Tax rates in basis points (`rate_bps INTEGER`).
- **Sync columns on every replicable table**:
  - `id TEXT PRIMARY KEY` (UUID v7)
  - `created_at TEXT NOT NULL` (ISO 8601 UTC, ms precision)
  - `updated_at TEXT NOT NULL`
  - `synced_at TEXT` (nullable)
  - `deleted_at TEXT` (nullable — soft delete)
  - `device_id TEXT NOT NULL`
  - `version INTEGER NOT NULL DEFAULT 1`
  Pure-local tables (e.g. `device_info`, `_migrations`) are exempt — keep the allowlist in `packages/sync-core/src/sync-contract.ts`.
- **Indexes**: every FK gets an index. Status-filter queries get a composite index with status first. Add the index in the same migration as the table.

## Writes (the repositories rule)

- **All business writes go through `apps/pos/electron/db/repositories/*`.** Never write to a business table directly from an IPC handler, service, or anywhere else.
- A repository write must, in **one better-sqlite3 transaction**:
  1. Upsert/update/soft-delete the business row (with `updated_at`/`version` bumped).
  2. Append a `sync_queue` entry with the post-image payload.
  3. Append an `audit_log` entry with before/after JSON + actor + action.
- If you skip step 2 or 3, sync and audit silently lie. CI will eventually have a test that scans repositories for this pattern.

## IPC

- **One `window.api` namespace.** Defined in `apps/pos/electron/preload.ts` via `contextBridge.exposeInMainWorld`.
- Every handler in `apps/pos/electron/ipc/handlers/<domain>.ts` registers itself in `electron/ipc/registry.ts`. The renderer-side client at `apps/pos/src/ipc/client.ts` mirrors the shape.
- No `ipcRenderer.send` strings sprinkled in components. No untyped channels.
- Handlers return typed results. Errors are caught and returned as `{ ok: false, error: { code, message } }`, never thrown across the IPC boundary.

## Money & tax

- Cents everywhere. `formatCents(n)` is the only place locale formatting happens.
- Tax rates are basis points (`1600` = 16.00%). Tax computation is pure-functional in `packages/pos-domain/src/tax.ts` and unit-tested.
- Order totals (`subtotal_cents`, `discount_cents`, `tax_cents`, `total_cents`) are computed once and **stored** on the order; never recomputed at read time. Reports trust the stored value.

## Snapshots

- `order_items.unit_price_cents`, `order_item_modifiers.price_delta_cents` + `modifier_name`, `order_items.tax_category_id` are **snapshots at order time**. They are not foreign keys to the live menu. Changing tomorrow's menu must not change yesterday's history.

## Hardware

- **Print failure never blocks the sale.** Order is saved to DB first; print is dispatched second via the spooler service. A failed print surfaces as a retryable toast.
- All printers (USB / Bluetooth / Network) go through `PrinterAdapter`. The renderer never knows which transport.

## FBR

- `FbrAdapter` is dumb: payload in, response out. **It does not own the queue.** The queue is owned by `apps/pos/electron/services/fbr-worker.ts`, which reads `fbr_submission_queue` and calls `submitInvoice`.
- Default mode is `noop` until production credentials are configured. The settings UI toggles `noop` ↔ `sandbox` ↔ `production`. Credentials live in the encrypted `settings` table, never in code or env files.

## Auth

- PINs are hashed with **argon2id** (never plain SHA). Stored as `pin_hash`. Never log or transmit PINs.
- Manager-approval flows re-prompt for a manager-role PIN — they don't re-use the cashier's session.

## Testing

- **Vitest** for unit tests. **Playwright** for Electron E2E.
- Domain logic in `packages/pos-domain` must have unit tests. Tax math, discount math, combo expansion, and price calc are pure functions — test them ruthlessly.

## Working in this repo

- The plan: `C:\Users\glh_0\.claude\plans\i-want-to-create-generic-flurry.md`.
- The phase being built: see `MEMORY.md` (project memory) when in doubt.
- When in doubt about a write that touches a business table, **stop and reach for the repositories layer**. Adding a column or workflow is fine; bypassing repositories is not.
