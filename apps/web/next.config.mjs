/** @type {import('next').NextConfig} */
const nextConfig = {
  // shared-types ships raw .ts — let Next transpile it from the workspace.
  transpilePackages: ['@cheeseoclock/shared-types'],
  // Menu images arrive as data URLs from the POS publish — no remote loader needed.
  images: { unoptimized: true },
};

export default nextConfig;
