import type { NextConfig } from "next";

/** Nagłówki bezpieczeństwa dla wszystkich odpowiedzi (CSP z nonce ustawia proxy.ts dla stron). */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Aparat tylko dla tej aplikacji (skaner kodów); reszta wyłączona.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Aplikacja nie używa next/image – optymalizator obrazów wyłączony (mniej publicznych punktów wejścia;
  // cdn.shopify.com jest wspólny dla wszystkich sklepów Shopify, więc nie wpuszczamy go do serwera).
  images: { unoptimized: true },
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  // Czcionki do PDF umów muszą trafić do funkcji serwerowych.
  outputFileTracingIncludes: { "/**": ["./lib/contracts/fonts/**"], "/api/program-drukarki": ["./agent/drukarka/**"] },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Odpowiedzi API z danymi nie mogą trafić do pamięci podręcznej po drodze.
      // Wyjątek: /api/dostepnosc (publiczna dostępność rozmiarów dla sklepu internetowego) – sama ustawia krótką pamięć podręczną.
      { source: "/api/:path((?!dostepnosc).*)", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

export default nextConfig;
