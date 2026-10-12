import { guardSection } from "@/lib/auth";

/** Zamówienia – dział „sprzedaz”. */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("sprzedaz");
  return children;
}
