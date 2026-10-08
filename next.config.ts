import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: { remotePatterns: [{ protocol: "https", hostname: "cdn.shopify.com" }] },
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  // Czcionki do PDF umów muszą trafić do funkcji serwerowych.
  outputFileTracingIncludes: { "/**": ["./lib/contracts/fonts/**"] },
};

export default nextConfig;
