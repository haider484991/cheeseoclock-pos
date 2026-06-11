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
2. Website URL: `https://cheeseoclock.net` (or the vercel.app URL until DNS lands)
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

## Free-tier limits (plenty for launch)

- Vercel Hobby: 100GB bandwidth/mo, serverless functions included
- Neon Free: 0.5GB storage, auto-suspends when idle (first request after idle
  takes ~1s extra — fine for a menu site)
