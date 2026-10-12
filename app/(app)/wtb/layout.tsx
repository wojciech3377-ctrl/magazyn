import { guardSection } from "@/lib/auth";

/** Dział „wtb” – tylko dla osób z dostępem (Pracownicy → uprawnienia). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("wtb");
  return children;
}
