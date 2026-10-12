import { guardSection } from "@/lib/auth";

/** Dział „dostawa” – tylko dla osób z dostępem (Pracownicy → uprawnienia). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("dostawa");
  return children;
}
