// Cheese O'Clock's website on Cloudflare Workers (27 Oct 2026). The entry around OpenNext's worker (.open-next/worker.js,
// made by `npx opennextjs-cloudflare build`; scripts/build-cloudflare.mjs copies this file next to it as cf-worker.mjs).
// Each request runs in a scope of its own:
//  - lib/db.ts keeps one small database pool per request in it (a Worker's socket belongs to the request that opened it);
//  - @vercel/functions' waitUntil (the WhatsApp webhook, the till's order pull) reaches this request's ctx.waitUntil.
// The database is reached through Hyperdrive: Supabase's certificate is from Supabase's own root CA, which a Worker's
// TLS will not accept, and Hyperdrive encrypts on to Supabase. The address it gives is the website's DATABASE_URL.
// The till's cloud copies go in the R2 bucket bound as TILL_BACKUPS (lib/backup-objects.ts finds it on globalThis).
import { AsyncLocalStorage } from 'node:async_hooks';
import handler from './.open-next/worker.js';

/** The one address of the site, as on Vercel: the bare domain and plain http go there by a 308, path and query kept. */
const SITE_HOST = 'www.cheeseoclock.net';
const REDIRECTED_HOSTS = new Set(['cheeseoclock.net', SITE_HOST]);

const scope = new AsyncLocalStorage();
globalThis[Symbol.for('@vercel/request-context')] = { get: () => scope.getStore()?.vercel };
globalThis[Symbol.for('site.request-scope')] = scope;

/**
 * What Vercel's CDN hands a browser for an answer meant for a CDN ("s-maxage=…"): the CDN's parts taken out and, with no
 * max-age of its own, "public, max-age=0, must-revalidate". No CDN keeps a Worker's answers, and a browser given a kept
 * page's "s-maxage=…, stale-while-revalidate=2592000" (or /api/store-status's) may show its own old copy meanwhile.
 */
function forBrowser(cacheControl) {
  const kept = cacheControl.split(',').map((d) => d.trim()).filter((d) => d && !/^(s-maxage|stale-while-revalidate)\b/i.test(d));
  return kept.some((d) => /^max-age\b/i.test(d)) ? kept.join(', ') : 'public, max-age=0, must-revalidate';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (REDIRECTED_HOSTS.has(url.hostname) && (url.hostname !== SITE_HOST || url.protocol === 'http:')) {
      return new Response(null, { status: 308, headers: { location: `https://${SITE_HOST}${url.pathname}${url.search}` } });
    }
    if (env.HYPERDRIVE) process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
    if (env.TILL_BACKUPS) globalThis[Symbol.for('site.backups-bucket')] = env.TILL_BACKUPS;
    const store = { pools: new Map(), vercel: { waitUntil: (promise) => ctx.waitUntil(promise) } };
    const response = await scope.run(store, () => handler.fetch(request, env, ctx));
    const cacheControl = response.headers.get('cache-control') ?? '';
    const forCdn = /s-maxage/i.test(cacheControl);
    // A workers.dev address (the test address before the domain moves) is never indexed.
    const unindexed = url.hostname.endsWith('.workers.dev');
    if (!forCdn && !unindexed) return response;
    const out = new Response(response.body, response);
    if (forCdn) out.headers.set('cache-control', forBrowser(cacheControl));
    if (unindexed) out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return out;
  },
};
