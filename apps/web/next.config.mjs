/** @type {import('next').NextConfig} */
const nextConfig = {
  // shared-types ships raw .ts — let Next transpile it from the workspace.
  transpilePackages: ['@cheeseoclock/shared-types'],
  // Menu images arrive as data URLs from the POS publish — no remote loader needed.
  images: { unoptimized: true },
  async redirects() {
    return [
      // Gizri / Punjab Colony was never a delivery zone (DHA & Clifton only).
      { source: '/delivery/gizri', destination: '/delivery', permanent: true },
    ];
  },
};

export default nextConfig;
