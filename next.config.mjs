/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle (.next/standalone): the VPS runs `node server.js`
  // with only the dependencies the server actually imports — no node_modules
  // checkout, no dev dependencies, no build cache on the box.
  output: "standalone",
  poweredByHeader: false,
  // No next/image usage; skip the image optimizer (and its native deps).
  images: { unoptimized: true },
  // Never ship these in the server bundle: the image optimizer (sharp/@img,
  // ~35 MB of native binaries) is disabled above and TypeScript is build-only.
  outputFileTracingExcludes: {
    "*": ["node_modules/@img/**", "node_modules/sharp/**", "node_modules/typescript/**"],
  },
  eslint: {
    // We keep type-checking on (below) but don't want lint nits to block builds.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
