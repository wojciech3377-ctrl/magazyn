import { guardSection } from "@/lib/auth";

/** Dział „umowy” – tylko dla osób z dostępem (Pracownicy → uprawnienia). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("umowy");
  return children;
}
