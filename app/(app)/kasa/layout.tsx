import { guardSection } from "@/lib/auth";

/** Dział „kasa” – tylko dla osób z dostępem (Pracownicy → uprawnienia). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("kasa");
  return children;
}
