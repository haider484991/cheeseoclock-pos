/** @type {import('next').NextConfig} */
const nextConfig = {
  // shared-types ships raw .ts — let Next transpile it from the workspace.
  transpilePackages: ['@cheeseoclock/shared-types'],
  // Menu images arrive as data URLs from the POS publish — no remote loader needed.
  images: { unoptimized: true },
  // Whether this build could read the database (lib/deploy-refresh.ts): a build without it renders
  // the kept pages from the built-in details, so the first till heartbeat refreshes them.
  env: { COC_BUILT_WITH_DB: process.env.DATABASE_URL ? '1' : '0' },
  webpack(config) {
    // shared-types is written for NodeNext ("./money.js" names money.ts). Type
    // imports vanish at compile time, but a runtime value from it (e.g.
    // PICKUP_DISCOUNT_PERCENT) needs webpack to find the .ts behind the .js.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  // The owner's phone dashboard: private pages and their own API (src/app/dashboard). Never indexed,
  // never kept by a cache, never in another site's frame, and the address never sent on to another site.
  async headers() {
    return [
      {
        source: '/dashboard/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
      {
        source: '/dashboard',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // Gizri / Punjab Colony was never a delivery zone (DHA & Clifton only).
      { source: '/delivery/gizri', destination: '/delivery', permanent: true },
      // The printed QR codes' short link to the shop's Google "write a review" page (5 Oct 2026: the A5 poster's QR
      // is 25 mm, too small for the long Google address; a short one makes a coarser, easier-to-scan code). Not
      // permanent, so the destination can change without reprinting. Place ID: Google's listing for the shop.
      {
        source: '/review',
        destination: 'https://search.google.com/local/writereview?placeid=ChIJ-V27j3c9sz4RUuIYjVnRvFU',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
