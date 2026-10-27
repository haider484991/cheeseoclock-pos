# Cheese O'Clock's website on Cloudflare Workers

**Since 27 Oct 2026, 11:20 UTC, the live site (www.cheeseoclock.net and the bare domain) is the Cloudflare Worker**
(Workers Paid, $5 a month). The same code still builds on Vercel from main, but Vercel only answers people whose DNS
still asks Namecheap's old nameservers (gone by about 29 Oct). On Vercel nothing changes: the Cloudflare parts switch
on only inside the Worker's entry.

⚠ **A push to main no longer reaches the live site.** Deploy the Worker (below) to put a change live.

## What is where

| Piece | Where |
|---|---|
| The addresses | DNS is on Cloudflare (zone cheeseoclock.net, Free plan, nameservers bill/mallory). Worker routes `www.cheeseoclock.net/*` and `cheeseoclock.net/*` sit on the zone's two records, which stay as they were (A 216.198.79.1, CNAME www → Vercel) but are proxied. They are routes, not custom domains: Cloudflare will not put a custom domain over an existing record, and deleting the records first leaves the names missing for a moment, which resolvers then remember for up to 30 minutes |
| The zone's settings | HSTS `max-age=63072000` (as Vercel). ECH off (Pakistani ISPs reset ECH connections). Automatic HTTPS Rewrites, Email Obfuscation, Rocket Loader, Speed Brain and Browser Integrity Check are off, and the security level is essentially off. No bot or AI-crawler blocking and no managed robots.txt, so the pages reach search engines exactly as the Worker sends them |
| Email | contact@cheeseoclock.net → cheeseoclock110@gmail.com through Cloudflare Email Routing (Namecheap's Redirect Email stopped with its DNS) |
| The Worker's entry | `cloudflare/worker.mjs`: a scope per request (lib/db.ts keeps that request's own database pool there; `@vercel/functions` waitUntil reaches `ctx.waitUntil`), Hyperdrive's address as `DATABASE_URL`, the bare domain and plain http sent to `https://www.cheeseoclock.net` by a 308 (as Vercel does), Vercel's browser `Cache-Control` for answers meant for a CDN, workers.dev never indexed |
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

## Measured (27 Oct 2026)

- The test Worker: 225 of 225 checks pass: every page, an order from checkout to delivered, the till's calls, the
  dashboard, Meta's webhook.
- CPU per request: median 60 ms, at most about 1 s (the share images). The free plan (10 ms) cut about 1 request in 5;
  Workers Paid with `limits.cpu_ms` 30000 none. A Worker made before the upgrade was still cut at 50 ms until that line.
- The live Worker against Vercel: 24 of 26 paths the same for search engines (title, description, canonical, robots,
  Open Graph, JSON-LD, h1, robots.txt, the sitemap, the redirects); only the 404 pages' canonical differs.

## The way back

Both ways are instant and leave no moment without an address. Vercel keeps deploying from main and reads the same
database with the same till secret.

- In Cloudflare → Workers routes, delete the two routes: Cloudflare then passes requests to the records' target, Vercel.
- Or set the two records back to DNS only (grey cloud): Cloudflare's DNS then answers with Vercel's addresses again.
