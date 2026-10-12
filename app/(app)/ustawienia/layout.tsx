import { guardAdmin } from "@/lib/auth";

/** Ustawienia – tylko administrator. */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await guardAdmin();
  return children;
}
