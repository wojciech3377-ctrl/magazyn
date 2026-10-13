import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Magazyn",
  description: "Magazyn sztuk z umowami – Telefoniki i Sneakers Depot",
  robots: { index: false, follow: false },
  // iPhone: po dodaniu do ekranu początkowego otwiera się jak aplikacja (bez paska Safari).
  appleWebApp: { capable: true, title: "Magazyn", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Każda strona renderowana na żądanie – wtedy skrypty dostają nonce z Content Security Policy (proxy.ts).
  await connection();
  return (
    <html lang="pl" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
