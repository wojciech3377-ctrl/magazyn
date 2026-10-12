import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
