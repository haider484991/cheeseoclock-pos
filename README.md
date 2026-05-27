# CheeseOclock POS

A modern, **offline-first point-of-sale system for restaurants & cafés**, built specifically with Pakistani retail in mind (FBR Digital Invoicing-ready, PKR-native, Urdu-friendly).

![Built with TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6) ![Electron](https://img.shields.io/badge/Electron-32-47848F) ![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57) ![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red)

---

## What's inside

| Domain | What you can do |
|---|---|
| **Checkout** | Take dine-in / takeaway / delivery orders. Image-first menu grid. Modifier modal. Multi-payment tender (cash, card, EasyPaisa, JazzCash, bank). Discounts with manager approval. |
| **Menu** | CRUD for categories, items (with photos), modifiers, combos, tax categories. |
| **Customers** | Phone-first lookup with autocomplete. Saved delivery addresses. Order history. Inline commit on tender — no modal interruptions. |
| **Inventory** | Ingredients with units, recipes (bill of materials per menu item), auto-decrement on sale, stock movements ledger, suppliers, purchase orders (draft → ordered → received). |
| **Reports** | Sales / items / cashiers / payments / order modes / discounts / stock + COGS, all date-range driven with inline SVG charts. |
| **Receipt printing** | ESC/POS via network port 9100 or a mock-to-disk adapter for dev. Logo + FBR IRN + QR. |
| **FBR Digital Invoicing** | Noop (dev) / sandbox / production adapters, persistent queue with retry, IRN + QR auto-attached to receipts. |
| **Cloud sync** | `sync_queue` push + apply-remote dispatcher. Mock & HTTP adapters ready; bring your own Postgres-backed `/sync/push` + `/sync/pull` endpoint. |
| **Users + auth** | PIN-based login (argon2id), three roles (admin / manager / cashier), capability gates. |
| **Settings** | Printer config, receipt branding (logo + store info), FBR creds, sync config, local backup/restore, About. |
| **Backup** | Daily auto-snapshots (keep last 14), manual export to USB, restore-from-file. |

---

## Tech stack

- **Electron 32** + **electron-vite** + **electron-builder**
- **React 18**, **TypeScript** (strict, `noUncheckedIndexedAccess`)
- **Tailwind CSS** + custom design tokens (Inter font, soft shadows, glass surfaces)
- **SQLite** (`better-sqlite3`) — single-file local database with `umzug` migrations
- **TanStack Query** for data fetching, **Zustand** for client state
- **Argon2id** PIN hashing (`@node-rs/argon2`), **UUID v7** for all replicable rows
- **pnpm workspaces** + **Turborepo** monorepo
- Optional: `electron-updater` (GitHub Releases), `@sentry/electron` (crash reports)

---

## Quick start (dev)

```bash
# Prerequisites: Node 22, pnpm 9.x
# Windows: Visual Studio Build Tools with "Desktop development with C++" (needed by better-sqlite3)

pnpm install                # installs everything + rebuilds native modules for Electron
pnpm pos:dev                # launches the Electron app with hot reload
```

Dev sign-in PINs (only seeded in dev mode):

| Role | PIN |
|---|---|
| Admin | `9999` |
| Manager | `5678` |
| Cashier | `1234` |

The dev seed populates a sample pizza menu, ingredients, suppliers, and tables so the checkout flow is immediately usable.

---

## Build a Windows installer

```bash
pnpm pos:build              # produces apps/pos/release/CheeseOclock POS-x.y.z-x64.exe
```

The unsigned installer is ~84 MB. Windows SmartScreen will show "unrecognized app" the first time — click **More info → Run anyway**. The warning goes away once you have a code-signing cert (see below).

To regenerate the app icon after editing `apps/pos/build/icon.svg`:

```bash
pnpm pos:gen:icon           # writes apps/pos/build/icon.ico (7 sizes) + icon.png
```

---

## Configuration (env vars at build time)

All optional. Set them in your CI secrets or your local shell before `pnpm pos:build`.

| Variable | What it does |
|---|---|
| `WIN_CSC_LINK` | Path or HTTPS URL to a `.pfx` Windows code-signing cert. Without it, the installer is unsigned. |
| `WIN_CSC_KEY_PASSWORD` | Password for the `.pfx`. |
| `SENTRY_DSN` | Sentry project DSN for **main-process** crash reporting. No-op if unset. |
| `VITE_SENTRY_DSN` | Same DSN for **renderer-process** crash reporting (Vite-prefixed so it's bundled). |
| `GH_TOKEN` | GitHub token for the release workflow to upload assets. CI provides `GITHUB_TOKEN` automatically. |

---

## Shipping a release (auto-update flow)

The app checks GitHub Releases for an update on launch and every 4 hours. When one is found, it downloads in the background and shows an in-app banner with "Restart now" / "Install on next launch".

To cut a release:

```bash
# 1. Bump apps/pos/package.json version
# 2. Tag and push
git tag v0.1.1
git push --tags
```

The `.github/workflows/release.yml` workflow then:

1. Runs on `windows-latest`
2. Installs deps, typechecks, builds the installer
3. Creates a **draft** GitHub Release with the `.exe`, `.exe.blockmap`, and `latest.yml` attached
4. Review the draft → click **Publish release** → installed apps pick it up within 4 hours

---

## Deploying to a customer

1. Build the installer: `pnpm pos:build`
2. Copy `apps/pos/release/CheeseOclock POS-x.y.z-x64.exe` to a USB stick or email it
3. On the customer's PC: double-click → (SmartScreen → More info → Run anyway) → install
4. First launch: **onboarding wizard** appears — collect store name, admin PIN, optional logo
5. Set up: Settings → Printer (Mock or your network printer IP), Branding (store info), FBR (defaults to Noop = dry-run until you have PRAL credentials)
6. **Tell them**: "Every Friday, Settings → Backup → Export copy → save to your USB. That's your disaster recovery."

---

## Repository layout

```
apps/
  pos/                          Electron desktop app
    electron/                   Main-process code
      db/                       SQLite + migrations + repositories
      services/                 Printer, FBR, sync, backup, updater, sentry
      ipc/                      Typed handlers per domain
      adapters/                 Printer + FBR + sync transport impls
    src/                        Renderer (React)
      features/                 One folder per page area (checkout, menu, …)
      components/               Cross-feature primitives (toast, etc.)
      stores/                   Zustand stores (session, checkout)
      ipc/                      Renderer-side IPC client + types
    build/                      electron-builder resources (icon.ico, icon.svg)
    scripts/                    Build-time scripts (icon generator)
    electron-builder.yml        Installer + publish config

packages/
  shared-types/                 Domain types + IPC contract (single source of truth)
  shared-schemas/               Zod schemas (derive TS types from these)
  pos-domain/                   Pure functions: tax, discount, validation, phone normalization
  printer-core/                 ESC/POS renderer + PrinterAdapter interface
  fbr-core/                     FBR adapter interface + invoice payload mapper
  sync-core/                    Sync contract + change-set types
  ui/                           Shared components (Button, Card, NumberPad, ImagePicker)

.github/workflows/release.yml   CI: build + publish on tag push
```

---

## Conventions (non-negotiable — see [`CLAUDE.md`](./CLAUDE.md))

- **All money in cents** (`INTEGER`). Tax rates in basis points. Never `REAL`.
- **All replicable tables** carry `id` (UUID v7), `created_at`, `updated_at`, `synced_at`, `deleted_at`, `device_id`, `version`.
- **All business writes go through repositories** — one transaction does the row update + `sync_queue` entry + `audit_log` entry.
- **Snapshots on order_items** (`unit_price_cents`, `modifier_name`, `tax_rate_bps_snapshot`) — never live-join to the menu.
- **PIN hashing**: argon2id only. PII redacted in `audit_log`.
- **Print failure never blocks the sale**. Sale saves first, print is fire-and-forget.

---

## License

Proprietary. © 2026 CheeseOclock. All rights reserved.
