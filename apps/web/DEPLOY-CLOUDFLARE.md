# Cheese O'Clock's website on Cloudflare Workers

Since 27 Oct 2026 the same code runs on Vercel (as before) and on Cloudflare Workers (Workers Paid, $5 a month). On
Vercel nothing changes: the Cloudflare parts switch on only inside the Worker's entry.

## What is where

| Piece | Where |
|---|---|
| The Worker's entry | `cloudflare/worker.mjs`: a scope per request (lib/db.ts keeps that request's own database pool there; `@vercel/functions` waitUntil reaches `ctx.waitUntil`), Hyperdrive's address as `DATABASE_URL`, the bare domain and plain http sent to `https://www.cheeseoclock.net` by a 308 (as Vercel does), workers.dev never indexed |
| The kept pages (ISR) | `cloudflare/open-next.config.ts`: Workers KV for the pages and for `revalidatePath`'s tags, regeneration as a request of the Worker to itself |
| The Workers | `cloudflare/wrangler.production.jsonc` (`cheeseoclock`, the live database) and `cloudflare/wrangler.test.jsonc` (`cheeseoclock-test`, a copy: Supabase schema `cftest`) |
| The database | Hyperdrive `cheeseoclock-db` → the website's own login through Supabase's session pooler, no query caching, about 5 connections. A Worker cannot reach Supabase itself: Supabase's certificate is from its own root CA, and a Worker's TLS verifies against public ones |
| The till's cloud copies | With no Blob store on Cloudflare they stay in the database tables (lib/backup-objects.ts), as before the Blob store |

## Build and deploy

```bash
node apps/web/scripts/build-cloudflare.mjs production --db-url-file "<file holding the database address>" --deploy
```

It builds in a throwaway copy under the temp folder, never in this checkout (on Windows the OpenNext build leaves
junctions pointing at the real packages, and a delete that follows one empties them). The top of the script lists what
the copy changes. The production build needs `NEXT_PUBLIC_META_PIXEL_ID` in the shell, as Vercel's build has it.

Secrets are set once on the Worker (they survive deploys) with `npx wrangler secret bulk <file.json>` from the build
copy's `apps/web`; the list is in `cloudflare/wrangler.production.jsonc`.

## Measured (27 Oct 2026, the test Worker)

- 225 of 225 checks pass: every page, an order from checkout to delivered, the till's calls, the dashboard, Meta's webhook.
- CPU per request: median 60 ms, at most about 1 s (the share images). The free plan (10 ms) cut about 1 request in 5;
  Workers Paid with `limits.cpu_ms` 30000 none. A Worker made before the upgrade was still cut at 50 ms until that line.

## The way back

While the domain is on Cloudflare: point `www` and the apex back to Vercel in Cloudflare's DNS (the Vercel project keeps
deploying from main and reads the same database). Nothing else changes: same database, same till secret.
