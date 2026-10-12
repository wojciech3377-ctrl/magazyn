import { guardSection } from "@/lib/auth";

/** Dział „komisanci” – tylko dla osób z dostępem (Pracownicy → uprawnienia). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("komisanci");
  return children;
}
