// Cheese O'Clock's website on Cloudflare Workers (27 Oct 2026). The entry around OpenNext's worker (.open-next/worker.js,
// made by `npx opennextjs-cloudflare build`; scripts/build-cloudflare.mjs copies this file next to it as cf-worker.mjs).
// Each request runs in a scope of its own:
//  - lib/db.ts keeps one small database pool per request in it (a Worker's socket belongs to the request that opened it);
//  - @vercel/functions' waitUntil (the WhatsApp webhook, the till's order pull) reaches this request's ctx.waitUntil.
// The database is reached through Hyperdrive: Supabase's certificate is from Supabase's own root CA, which a Worker's
// TLS will not accept, and Hyperdrive encrypts on to Supabase. The address it gives is the website's DATABASE_URL.
import { AsyncLocalStorage } from 'node:async_hooks';
import handler from './.open-next/worker.js';

/** The one address of the site, as on Vercel: the bare domain and plain http go there by a 308, path and query kept. */
const SITE_HOST = 'www.cheeseoclock.net';
const REDIRECTED_HOSTS = new Set(['cheeseoclock.net', SITE_HOST]);

const scope = new AsyncLocalStorage();
globalThis[Symbol.for('@vercel/request-context')] = { get: () => scope.getStore()?.vercel };
globalThis[Symbol.for('site.request-scope')] = scope;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (REDIRECTED_HOSTS.has(url.hostname) && (url.hostname !== SITE_HOST || url.protocol === 'http:')) {
      return new Response(null, { status: 308, headers: { location: `https://${SITE_HOST}${url.pathname}${url.search}` } });
    }
    if (env.HYPERDRIVE) process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
    const store = { pools: new Map(), vercel: { waitUntil: (promise) => ctx.waitUntil(promise) } };
    const response = await scope.run(store, () => handler.fetch(request, env, ctx));
    // A workers.dev address (the test address before the domain moves) is never indexed.
    if (!url.hostname.endsWith('.workers.dev')) return response;
    const marked = new Response(response.body, response);
    marked.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return marked;
  },
};
