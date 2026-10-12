import { guardSection } from "@/lib/auth";

/** Dział „magazyn” – tylko dla osób z dostępem (Pracownicy → uprawnienia). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("magazyn");
  return children;
}
