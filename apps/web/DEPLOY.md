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

## Website messages and selling on the website (from v0.7.30)

- **What is new.** On the till the owner sets, in Settings → Online orders →
  "Website messages & smallest delivery order": a closed notice (with a last
  day, Karachi time, or none), an announcement, and the smallest website
  DELIVERY order (Rs 0–5,000; pick-up is never refused, orders rung up at
  the till are never checked). They travel in the settings block
  (`closedNotice`, `announcement`, `minDeliveryOrderCents`: shared-types
  `web-bridge.ts`, WEBSITE MESSAGES). In Menu, whoever may edit the menu
  sets each item "On the website", "Pick-up only" or "Not on the website",
  and each category on or off the website (migration 0045). Delivery
  charges always go. No website schema change.
- **Deploy the website first** (a push to `main` deploys it). Until a till
  sends the new fields the website is exactly as before, and a v0.7.29
  till's publish keeps working: its block has no message fields (the website
  keeps the ones it stored) and its items never carry `pickupOnly`. An older
  website drops both — tills first would show no messages and let a
  pick-up-only item be ordered for delivery. Check it on a Vercel
  **preview** first, with its own Neon branch and its own `BRIDGE_SECRET`
  (see above).
- **Update BOTH tills the same day.** Migration 0045 adds the two columns,
  and the till link copies menu rows between the tills (the link does not
  tell a till which version the other runs, so nothing in the till warns
  about this). A website setting changed on an updated till reaches a
  v0.7.29 till without the column. When that till updates later, 0045 gives
  the item "On the website" at the SAME row version, and the next change to
  that item on it (a price, a photo, hiding it for the night) sends "On the
  website" back to the first till, which takes it: the owner's setting is
  LOST ON BOTH TILLS, silently, and the next publish from either till puts
  the item back on the website. And a v0.7.29 till's Publish (or its menu
  file import, or "Publish the menu by itself") sends every item again —
  hidden ones back on the website, no pick-up-only flags — until an updated
  till publishes. **Change nothing under "On the website" (Menu) until both
  tills show 0.7.30** (Settings → About → App version). If something was
  changed anyway: once both are updated, open Menu → Items on each till and
  compare the Website column; set again whatever differs, and publish.
- **After both tills are updated there is nothing to press.** Every item is
  "On the website" and every category on it (0045's defaults), which is the
  menu the website already has, and the website holds no message (today's
  words). A till that has "Publish the menu by itself" saved sends its
  block by itself at start (it now counts in the settings stamp; at its
  defaults it changes nothing on the website). The owner's first Save on
  "Website messages & smallest delivery order" sends the messages (alone,
  never the menu); after setting items "Pick-up only" or "Not on the
  website", press "Publish menu to website" (or let "Publish the menu by
  itself" do it). The status line under the connection says "Delivery
  areas, pick-up & website messages: website updated …".
- **If the website is older than the tills** (its deploy failed or was
  rolled back while the tills updated): an older website takes the menu and
  the block but drops the messages and "Pick-up only" while saying it
  stored them. The till notices it (the website does not say
  `websiteMessages: true`) whenever it sent any of them, and says "The
  website is older than this till…" in Settings → Online orders and in the
  publish message; it does not send those settings again by itself. Fix
  the website, then press "Publish menu to website" once.
- A menu file import keeps each item's and category's website setting (a
  new item comes in on the website). A **fresh start** removes the items
  and categories but gives the file's item or category of the SAME name
  (ignoring case, spaces and punctuation) the setting the removed one had.
  Its preview counts the settings it can't keep — set on items or categories
  the file does not bring back by that name, or on two of one name set
  differently (nothing is carried for that name) — and says nothing about
  the website when it keeps them all. Whatever of those the file brings back
  is on the website, and the import publishes the menu at once — set them
  again in Menu and publish.
- A deal's choices are not items: an item set "Not on the website" or
  "Pick-up only" is still a choice in any deal that offers it ("Large:
  Fajita Pizza"), for delivery too. To stop that, take the choice out of the
  deal (Menu → Choices). The item's dialog says so.
- An item photo too big for the website (over about 300 KB) was left out
  silently before; now the publish says which items went without a picture,
  and the Menu editor warns on the item (only on items that go to the
  website). Pick the photo again (the till makes it smaller).
- **What to check on the website.** Before any 0.7.30 till has saved: the
  home page, /menu and the area pages read exactly as before (the Phase 7
  FAQ still says "No minimum on the website"), and an order while the shop
  is closed gets today's "We are not taking online orders…" sentence. After
  the owner's Save: the announcement, while on, shows in the home page's
  hero and ticker and on /menu (the Save refreshes the pages; never in a
  page title, description or structured data — but it is words on the home
  page, so Google may quote it in its results for a while after it is
  switched off); the closed notice replaces the closed explanation on
  /menu, at checkout and in the order refusal, only while the website is
  closed and until the end of its last day in Karachi (the WhatsApp buttons
  stay; a /menu page left open drops an ended notice at its next status
  check, within about a minute); a website delivery under the smallest
  order is refused with how much to add, a pick-up never is. An item set
  "Pick-up only" shows as pick-up only and a delivery with it is refused;
  for a pizza set pick-up only in one size, only that size is (the other
  sizes still deliver) — on the card and in its choices sheet alike: with
  online pick-up off that size shows "Pick-up only" and can't be chosen or
  added; with it on, it can, and says it is pick-up only.

## Shop details and home page (from v0.7.31)

- **What is new.** The owner sets the shop's details in Settings → Shop &
  logo → "Website: shop details (both tills)": the name, tagline, call line,
  WhatsApp lines, street address, social links, price range; the opening
  hours (**display only** — website ordering still follows the till's shift
  open and close); what the rider and the counter take (website words only,
  never the till's Pay buttons; cash always); the WhatsApp greeting; the
  allergy notice; and the home page's featured items. They travel as the
  **shop block**, a stamped block of its own next to the settings block
  (shared-types `web-bridge.ts`, THE SHOP BLOCK), stored in the same
  `site_menu` row under `shop`. No website schema change, no migration.
- **Nothing changes until the owner saves a shop card.** With no shop block
  stored, every page is v0.7.30's byte for byte (`lib/pages-golden.test.ts`
  pins every page's HTML, title, description, canonical, Open Graph, JSON-LD,
  the manifest, robots.txt, the sitemap and the share images). Today's
  details are the frozen defaults in `packages/shared-types/src/website-shop.ts`
  — the only place the shop's name, numbers and address are written.
- **Deploy the website first** (a push to `main` deploys it), then both tills
  the same day. An older website strips `shop` from a publish and has no
  `PUT /api/bridge/shop` (404): the till's Settings → Online orders and the
  publish message say the website needs its update, and the till sends
  nothing more by itself. A till up to v0.7.30 never sends `shop`, and the
  website keeps the stored one (its publish can't clear it).
- **How it travels.** A shop card Save sends the block ALONE
  (`PUT /api/bridge/shop`): the website puts it on the stored row and
  changes nothing else — never the menu, never the settings block. Every
  Publish (and import, and "Publish the menu by itself") carries it with the
  menu. An older block (another till's, saved earlier) is ignored; a till
  may always replace its own with a later Save. A block the website refuses
  (400 `shop_invalid`, with the reason) never stops the menu: the till sends
  it again without the block. `GET /api/bridge/status` says which block the
  website holds (`shop`) and the featured home items it can't find on the
  menu (`homeMissing`, also in every publish answer).
- **Rolling the website back to v0.7.30 drops the stored details** at the next
  publish (v0.7.30 rebuilds the row from each publish): the pages show
  today's details. Once the website is back on the new version the tills see
  no block held and send it again by themselves (at start-up, or the next
  Save or Publish).
- **The pages.** The root layout (metadata and the Restaurant JSON-LD), the
  header and footer, every page and the share images read the details with
  the delivery areas, in ONE query per page (`lib/site-facts.ts`: both blocks
  and the menu without its photos). `/_not-found` is `force-static`, so that
  read never makes it dynamic: it takes the details at build, and again
  after a publish revalidates the site. The app manifest is static and
  follows within the hour (a publish's revalidation does not reach a route
  handler). `error.tsx` runs in the browser: the root layout hands it the
  owner's name and numbers (`ShopContactProvider`). Check with a build that
  the route table is unchanged (`○ /`, `○ /_not-found`, `● /delivery/[area]`,
  `ƒ /menu`, `ƒ /track/[id]`), with no `DATABASE_URL`, and with one that
  answers (a Neon branch, or a local stand-in) so the reads are made during
  the build. A `DATABASE_URL` that can't be reached now FAILS the build by
  design (see "A database the website can't read" below).
- **The words.** Hours are tokens (`{hours}`, `{opens}`, `{closes}`, `{days}`);
  "daily", "every day" and "every night" show only while the shop opens all
  seven days; "past midnight" (the late-night page's premise) only while it
  closes after midnight — otherwise that page reads without it (its slug
  stays; its title and H1 always name the closing time). Sentences that say
  cash ONLY step aside once the rider takes more; "Cash on delivery" stays
  (cash is always taken; JSON-LD `paymentAccepted` lists the others after
  it). Lines built on the name's pun ("It's always Cheese O'Clock") show only
  while the name is today's. Social links show in the footer and in JSON-LD
  `sameAs`, both only when there is one. The logo, the share images' alt
  text and the prose naming the kitchen's street ("Rahat Commercial", "our
  Phase 6 kitchen") stay in code: the till's address card says so.
- **The home page's brand line (CheeseTime)** works from the owner's opening
  hours alone, as v0.7.30 did from today's: it never asks the website (no
  request per page view). Whether the kitchen is taking website orders is
  `/menu`'s closed banner's to say.
- **A database the website can't read.** A page Next KEEPS (the home page,
  the delivery hub and area pages, the three landing pages, `/_not-found`,
  the app manifest) whose read fails on a server that has read nothing yet
  now FAILS instead of rendering today's details with no prices: Next keeps
  serving the last good page and tries again. So a **build** (`next build`
  with a `DATABASE_URL`) whose database can't be reached fails, and the
  live site stays on the last deploy — redeploy once Neon answers. A read
  that fails after one succeeded renders from that one (as before); no
  `DATABASE_URL` at all builds today's site (without menu prices); `/menu`
  and `/track` (dynamic) still render from today's details rather than fail.
- **Prices, deals and tax from the menu (sweep B2).** No menu price is typed
  in the website's code any more: the home page's featured pizzas, burger and
  value deals (the owner's Home page card; today's five signature pizzas, the
  Signature Cheese Dipped and the three deals with none saved) show the
  PUBLISHED menu's prices, and each deal's saving is worked out from the menu
  (`lib/home-lineup.ts`, `menu-view` `dealWorthCents`); the landing pages'
  "From …" lines and the cheese and dip extras are `{price:…}` tokens
  (`lib/menu-prices.ts`); the tax words are the food's one rate
  (`lib/tax-words.ts`). A Publish moves them (every publish revalidates the
  site). A featured item the menu no longer has (renamed, deleted, priced at
  0, off the website) is **hidden** — never shown at a zero price — and the
  till's publish message says which (`homeMissing`). With the menu **unknown**
  (a build or preview with no `DATABASE_URL`, nothing published yet) the home
  page shows its lineup without prices and the landing pages say it without
  one; with a database the build reads the menu like any page read.
- **Before the first deploy of B2**, read `GET /api/menu` on the live site
  and check the names the code looks for are all there, spelled the same:
  `Cheesy Star — Large`, `Crown Crust — Large`, `Shawarma Pizza — Large`,
  `Meat Lovers — Large`, `Cheetos — Large`, `Signature Cheese Dipped`,
  `Big Two`, `Family Feast`, `Perfect Pair` (the home page); the four burgers,
  the six sides and two masala fries, the `Add cheese` choice in an
  `Extras · Burgers` group and the `Dips on the side` choices (the landing
  pages, `PRICE_LINES`); one `… — 1 litre` drink and the deals' `Large:` /
  `Medium:` pizza choices (the deals' saving); every food item at one tax
  rate. A name that is missing hides its card or takes the sentence's
  wording without a price — nothing wrong is printed, but content goes.
- **A featured item's own photo.** Today's six dishes use the shop's own
  photos (`public/images/menu`). Another item the owner features shows the
  till's photo through `GET /api/menu-photo/<posItemId>?v=<version>` (the
  page links it; the data URL is never inlined into a static page), else a
  plain panel with its name. The route serves only a published item's
  raster photo (never SVG), cached for good under its version.
- **What to check on a Vercel preview** (its own Neon branch and
  `BRIDGE_SECRET`, see above): before any shop card is saved, the home page's
  page source (JSON-LD hours 12:00–01:00, `paymentAccepted` "Cash on
  Delivery", no `sameAs`), the footer and the late-night page read as
  before. After a test Save of the hours: the footer, the home page, the
  JSON-LD and the late-night title change at once; `/_not-found` still
  answers.

## Free-tier limits (plenty for launch)

- Vercel Hobby: 100GB bandwidth/mo, serverless functions included
- Neon Free: 0.5GB storage, auto-suspends when idle (first request after idle
  takes ~1s extra — fine for a menu site)
