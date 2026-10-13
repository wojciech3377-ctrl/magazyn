import { requireProfile } from "@/lib/auth";
import { PdfViewer } from "./PdfViewer";

export const metadata = { title: "Wydruk" };
export const dynamic = "force-dynamic";

/**
 * Podgląd PDF z paskiem: Wróć, Drukuj, Udostępnij / Zapisz. Na iPhonie (aplikacja z ekranu początkowego) PDF otwarty
 * bezpośrednio zajmuje cały ekran bez przycisków – tu zawsze jest wyjście i drukowanie (przez „Udostępnij” → Drukuj).
 */
export default async function PdfPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireProfile();
  const sp = await searchParams;
  // Tylko pliki tej aplikacji (bez otwierania obcych adresów).
  const src = sp.src && /^\/api\/[A-Za-z0-9/_\-?=&%.,]+$/.test(sp.src) && !sp.src.includes("//") ? sp.src : null;
  const back = sp.wroc && /^\/[A-Za-z0-9/_\-?=&%.,]*$/.test(sp.wroc) && !sp.wroc.startsWith("//") ? sp.wroc : "/";
  // „Dalej” po wydruku (np. Kasa → nowa sprzedaż).
  const next = sp.dalej && /^\/[A-Za-z0-9/_\-?=&%.,]*$/.test(sp.dalej) && !sp.dalej.startsWith("//") ? sp.dalej : null;
  const name = (sp.nazwa ?? "dokument").replace(/[^A-Za-z0-9_.\-]/g, "-").slice(0, 80) || "dokument";
  if (!src) return <p className="p-6 text-sm text-muted">Brak dokumentu do wyświetlenia.</p>;
  return <PdfViewer src={src} back={back} next={next} nextLabel={sp.dalej_tekst?.slice(0, 40) ?? "Dalej"} name={name.endsWith(".pdf") ? name : `${name}.pdf`} title={sp.tytul?.slice(0, 80) ?? "Dokument"} />;
}
