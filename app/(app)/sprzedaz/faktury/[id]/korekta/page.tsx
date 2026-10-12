import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateOnly } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { CorrectionForm } from "./CorrectionForm";

/** Korekta faktury z KSeF: podgląd pozycji przed korektą i edycja pozycji po korekcie. */
export default async function CorrectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireProfile();
  const { data: inv } = await supabase.from("invoices").select("id, number, issue_date, status, ksef_number, kind, buyer").eq("id", id).maybeSingle();
  if (!inv) notFound();
  const { data: items } = await supabase.from("invoice_items").select("name, quantity, unit, unit_price_gross, total_gross, vat").eq("invoice_id", id).order("position");
  const ok = inv.status === "accepted" && !!inv.ksef_number && inv.kind !== "correction";
  return (
    <>
      <PageHeader title={`Korekta faktury ${inv.number}`} sub={`${dateOnly(inv.issue_date)} · ${(inv.buyer as { name: string }).name}${inv.ksef_number ? ` · KSeF ${inv.ksef_number}` : ""}`} actions={<Link className="btn-secondary" href={`/sprzedaz/faktury/${id}`}>Wróć do faktury</Link>} />
      {!ok ? <Notice tone="error">Korektę wystawia się do faktury przyjętej w KSeF (nie do innej korekty).</Notice> : (
        <CorrectionForm
          originalId={id}
          before={(items ?? []).map((i) => ({ name: i.name, quantity: Number(i.quantity), unit: i.unit, unit_price_gross: Number(i.unit_price_gross), vat: i.vat === "23" ? "23" : "margin" }))}
        />
      )}
    </>
  );
}
