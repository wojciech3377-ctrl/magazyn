import { guardSection } from "@/lib/auth";

/** Sprzedaż: zamówienia (dział „sprzedaz”) albo faktury i JPK (dział „faktury”). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("sprzedaz", "faktury");
  return children;
}
