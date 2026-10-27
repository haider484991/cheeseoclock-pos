import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import kvIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache';
import memoryQueue from '@opennextjs/cloudflare/overrides/queue/memory-queue';
import kvNextTagCache from '@opennextjs/cloudflare/overrides/tag-cache/kv-next-tag-cache';

// The kept pages (ISR) on Cloudflare (27 Oct 2026): Workers KV holds them and revalidatePath's tags (a till's
// publish refreshes every page), and each regeneration is a request of the Worker to itself (WORKER_SELF_REFERENCE).
// scripts/build-cloudflare.mjs copies this file to the app's root in its build copy.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  tagCache: kvNextTagCache,
  queue: memoryQueue,
});
