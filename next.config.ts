import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: { remotePatterns: [{ protocol: "https", hostname: "cdn.shopify.com" }] },
  experimental: { serverActions: { bodySizeLimit: "15mb" } },
};

export default nextConfig;
