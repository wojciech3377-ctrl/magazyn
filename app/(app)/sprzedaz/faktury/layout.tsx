import { guardSection } from "@/lib/auth";

/** Faktury i korekty – dział „faktury”. */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await guardSection("faktury");
  return children;
}
