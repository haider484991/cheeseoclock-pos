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
  async redirects() {
    return [
      // Gizri / Punjab Colony was never a delivery zone (DHA & Clifton only).
      { source: '/delivery/gizri', destination: '/delivery', permanent: true },
    ];
  },
};

export default nextConfig;
