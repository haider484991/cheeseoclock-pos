# CheeseOclock

Point-of-Sale system (Electron) + online ordering website (Next.js) for CheeseOclock, a pizza/cafe in Pakistan.

- **POS**: offline-first, hardware-real (USB / Bluetooth / Network thermal printers, barcode scanner, cash drawer), multi-user PIN login.
- **FBR-ready**: Pakistan Digital Invoicing (PRAL) adapter built in; live submission flipped on once credentials arrive.
- **Cloud-ready**: sync-queue + adapter interfaces in place; remote backend swap is deferred (PowerSync / Supabase / cr-sqlite candidates).

See [`CLAUDE.md`](./CLAUDE.md) for engineering conventions.
The implementation plan lives at `C:\Users\glh_0\.claude\plans\i-want-to-create-generic-flurry.md`.

## Prerequisites

- Node.js 20.11+
- pnpm 9+
- Windows: Visual Studio Build Tools with the "Desktop development with C++" workload (needed by `better-sqlite3` native build)

## Quick start

```bash
pnpm install
pnpm pos:dev      # launch the Electron POS in dev mode
pnpm pos:build    # produce a Windows installer
```

## Monorepo layout

| Path | What |
|---|---|
| `apps/pos` | Electron desktop POS |
| `apps/web` | Customer-facing ordering site (Next.js) — added in Phase 6 |
| `packages/shared-types` | Domain types shared across apps |
| `packages/shared-schemas` | Zod schemas (single source of truth) |
| `packages/ui` | Reusable React primitives |
| `packages/pos-domain` | Pure domain logic (tax, pricing, combos) |
| `packages/printer-core` | `PrinterAdapter` interface + ESC/POS templates |
| `packages/fbr-core` | `FbrAdapter` interface + invoice mapper |
| `packages/sync-core` | `SyncAdapter` interface + sync-queue contract |
| `services/order-intake` | Fastify bridge from website → POS (Phase 6) |
