import { guardSection } from "@/lib/auth";

/** Dział „katalog” – tylko dla osób z dostępem (Pracownicy → uprawnienia). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("katalog");
  return children;
}
