import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Magazyn",
  description: "Magazyn sztuk z umowami – Telefoniki i Sneakers Depot",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
