import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  typescript: {
    // `pnpm lint:types` checks the types with TypeScript 7, whose package no longer ships the
    // compiler API that `next build` loads for its own check.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
