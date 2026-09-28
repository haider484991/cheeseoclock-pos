# Deploying cheeseoclock.net (Vercel + Neon, zero budget)

End-to-end this takes ~30 minutes. Do it in this order.

## 1. Create the database (Neon)

1. Go to https://neon.tech → sign up free (GitHub login is fine)
2. Create a project — name it `cheeseoclock`, region **AWS ap-southeast-1 (Singapore)** (closest to Pakistan)
3. Copy the **connection string** (looks like `postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`)
4. Initialize the schema from your dev machine:

   ```powershell
   $env:DATABASE_URL = "postgresql://...paste it here..."
   pnpm --filter @cheeseoclock/web db:init
   # → "Applied N statements. Database ready."
   ```

## 2. Generate the bridge secret

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save this — you'll paste it in **two** places (Vercel env + POS Settings).

## 3. Deploy to Vercel

1. https://vercel.com → sign up free → **Add New → Project**
2. Import the `haider484991/cheeseoclock-pos` GitHub repo
3. **Root Directory**: set to `apps/web` (Vercel auto-detects Next.js)
4. Environment variables (Settings → Environment Variables, all environments):
   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `BRIDGE_SECRET` | the secret from step 2 |
5. Deploy. You'll get `https://cheeseoclock-xxx.vercel.app` — open it, the home
   page should load. `/menu` will show "Menu coming right up" until you publish.

> Vercel build command/output are auto-detected. If the monorepo build fails,
> set Install Command to `pnpm install` and Build Command to
> `pnpm --filter @cheeseoclock/web build` in project settings.

## 4. Point cheeseoclock.net at Vercel

1. Vercel project → Settings → Domains → add `cheeseoclock.net` and `www.cheeseoclock.net`
2. Vercel shows you the DNS records. At your domain registrar (wherever you
   bought cheeseoclock.net), set:
   - `A` record `@` → `76.76.21.21`
   - `CNAME` record `www` → `cname.vercel-dns.com`
3. Wait for DNS (minutes to a few hours). Vercel auto-issues the SSL cert.

## 5. Connect the POS

1. In the POS (v0.4.1+): **Settings → Website — online ordering**
2. Website URL: `https://www.cheeseoclock.net` — the **www** address exactly as the site answers on it (or the vercel.app URL until DNS lands). The apex `cheeseoclock.net` redirects to www; POS builds before v0.4.7 lose the bridge secret on that redirect and every call fails with HTTP 401.
3. Bridge secret: paste the same secret from step 2
4. Tick **Accept online orders** → Save
5. Click **Publish menu to website** → you should see "Menu published 🎉"
6. Open cheeseoclock.net/menu — your real menu is live

## 6. Smoke test (do this before opening day!)

1. On your phone, go to cheeseoclock.net → order a pizza → COD checkout
2. Within ~20s the POS shows a toast "🌐 New online order!" and the order
   appears in Live Orders → New column (with a kitchen ticket printed)
3. Walk it through the board: Start preparing → Ready → Assign rider →
   Delivered + collect cash
4. Watch the tracking page on your phone update at every step
5. Done — you're taking online orders

## Day-to-day

- **Changed the menu/prices?** Settings → Website → "Publish menu to website"
- **Going offline / closing?** Untick "Accept online orders" (site still shows
  the menu; orders queue server-side until you re-enable — or disable ordering
  by unpublishing)
- **Order didn't arrive?** Settings → Website shows last check time + errors.
  "Check for orders now" forces an immediate poll.

## Delivery areas, fees and the pick-up offer (from v0.7.29)

- The owner sets them on the till (Settings → Delivery areas & fees, and Money
  & discounts → Website pick-up). They travel as a settings block, stored in
  the `site_menu` row with the menu. No schema change.
  - **A Save sends the block alone** (`PUT /api/bridge/settings`) with only the
    "Delivery Charge (Rs N)" items its areas charge. The website keeps the
    menu it already has (the last one published) and puts just those items
    into it. **Saving never publishes menu changes** made on the till and not
    published: prices, items and photos go only with Publish (or a menu file
    import, or "Publish the menu by itself" when the owner switches it on).
  - The owner's Publish sends the whole menu with the block
    (`PUT /api/bridge/menu`), as before.
- Until a block arrives the site is exactly as before: the built-in 21 areas
  and fees, and the till's heartbeat % for pick-up.
- **Deploy the website before updating the tills.** An older website has no
  `/api/bridge/settings` (404) and drops a block sent with the menu; the
  till's Settings → Online orders says the website needs its update, and the
  till sends nothing more by itself. Once the website is updated, save the
  delivery areas again on the till (only the areas go); Publish also works,
  and sends the menu too.
- **Don't change a fee, or switch an area off, until BOTH tills show 0.7.29**
  (Settings → About → App version). A Save that leaves no area on at a fee
  (every Rs 250 area moved to Rs 300, say) switches that fee's charge item
  off. A till still on 0.7.28 never sends the areas, so while it holds the
  website link the website keeps charging the old item — and it refuses a
  website order carrying a switched-off item: after 5 tries (about a minute)
  it cancels the order on the website. Saving today's fees with every area
  on (the one Save after the update) keeps today's Rs 200 and Rs 250 items on.
- `GET /api/bridge/status` also says which block the website holds and
  whether it fits the stored menu: a till reads it once at start-up, so a
  website database rolled back to an older copy gets the areas again.
- The home, delivery-area and landing pages are static and refreshed from the
  stored block: at build, after every publish or areas Save, and at least
  hourly. The area pages must not set `dynamicParams = false`: with it,
  `next start` answered 404 for all seven after any publish
  (`isr-routes.test.ts`). Any other `/delivery/<slug>` (a made-up one,
  another case or spelling) is sent by the middleware (`src/middleware.ts`,
  Edge Middleware on Vercel, for `/delivery/<one segment>` only) to the
  site's own 404 page — "Page not found", uncached — so it is never rendered
  or cached as a page of its own. Check the area pages on a Vercel preview
  after a test publish before merging: all seven 200, and `/delivery/nope`
  404 with "This page went cold" in the page source. With no database they
  use the built-in areas and fees; on a database error, the last areas and
  fees that server read, else the built-in ones.
- A street or spot in an area switched off is not listed under "Streets &
  spots we cover" on its area page, nor on its `/delivery` card
  (`lib/areas.ts` `coveredLandmarks`); with every area on, the lists are as
  before.
- **On the till (what to tell the owner and the cashiers):**
  - Picking a delivery area puts its fee on the bill by itself; picking
    another area swaps it. Clearing the area, or switching the order to
    Takeaway or foodpanda, takes it off; switching back to Delivery puts it
    back.
  - A fee the cashier takes off by hand stays off unless the area is changed
    (another area, or cleared and picked again), or the order is switched
    away from Delivery and back. "Put it back" on the charge row puts it back.
  - A charge already on the bill keeps its price when a fee is changed in
    Settings. The charge row then says so ("The bill has a Rs 250 delivery
    charge — this area’s charge is Rs 300"), and "Change to Rs 300" swaps it in
    one tap. The same happens for another delivery charge tapped on by hand.
- Before testing on a Vercel **preview**, give the Preview environment its own
  Neon branch and its own `BRIDGE_SECRET`: with the variables set for "all
  environments", a sandbox till publishing to a preview would replace the
  live menu and areas.

## Free-tier limits (plenty for launch)

- Vercel Hobby: 100GB bandwidth/mo, serverless functions included
- Neon Free: 0.5GB storage, auto-suspends when idle (first request after idle
  takes ~1s extra — fine for a menu site)
