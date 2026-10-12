import { UNIT_STATUS } from "@/lib/labels";

/**
 * Historia sztuk (unit_events) po ludzku – dla nas (Magazyn → Historia, karta sztuki) i dla komisanta (panel → Historia).
 * `forConsignor` ukrywa szczegóły wewnętrzne (zamówienia, ceny zakupu).
 */
export type HistoryEvent = { type: string; data: Record<string, unknown> | null; created_at: string };

const pln = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
  ? new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(Number(v)) : null);

export function describeEvent(e: HistoryEvent, forConsignor = false): { title: string; detail: string | null; tone: "green" | "blue" | "amber" | "slate" | "red" } {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const st = (k: unknown) => (typeof k === "string" ? UNIT_STATUS[k] ?? k : "");
  switch (e.type) {
    case "received":
      return { title: "Przyjęta do magazynu", detail: typeof d.source === "string" && !forConsignor ? d.source : null, tone: "green" };
    case "moved":
      return { title: "Przeniesiona do innej lokalizacji", detail: null, tone: "blue" };
    case "transfer":
      return { title: "Wysłana do innego sklepu / magazynu", detail: null, tone: "blue" };
    case "transfer_cancelled":
      return { title: "Przesunięcie anulowane – wróciła na stan", detail: null, tone: "slate" };
    case "sold":
      return { title: "Sprzedana", detail: forConsignor ? null : [typeof d.order === "string" ? `zamówienie ${d.order}` : null, typeof d.note === "string" ? d.note : null, typeof d.source === "string" ? d.source : null].filter(Boolean).join(" · ") || null, tone: "green" };
    case "status": {
      const to = d.to as string | undefined;
      if (to === "reserved") return { title: "Zarezerwowana – zamówienie w sklepie internetowym", detail: null, tone: "amber" };
      if (to === "sold") return { title: "Sprzedana", detail: null, tone: "green" };
      if (to === "in_stock" && d.from === "in_transit") return { title: "Dotarła – na stanie", detail: null, tone: "green" };
      if (to === "in_stock") return { title: "Wróciła na stan", detail: typeof d.note === "string" && !forConsignor ? d.note : null, tone: "blue" };
      if (to === "removed") return { title: forConsignor ? "Wycofana ze sprzedaży" : "Wycofana", detail: typeof d.reason === "string" && !forConsignor ? d.reason : null, tone: "slate" };
      return { title: `Status: ${st(to)}`, detail: d.from ? `wcześniej: ${st(d.from)}` : null, tone: "slate" };
    }
    case "returned":
      return { title: "Zwrot od klienta", detail: d.back_to_stock === undefined ? null : d.back_to_stock ? "wraca na stan" : "do sprawdzenia", tone: "amber" };
    case "swapped":
      return { title: "Zamieniona przy pakowaniu", detail: null, tone: "slate" };
    case "contract":
      return d.contract_id ? { title: forConsignor ? "Dokument (umowa / faktura) dołączony" : "Umowa przypisana", detail: typeof d.note === "string" && !forConsignor ? d.note : null, tone: "green" }
        : { title: forConsignor ? "Dokument odpięty" : "Umowa odpięta", detail: typeof d.note === "string" && !forConsignor ? d.note : null, tone: "slate" };
    case "consignor_returned":
      return { title: forConsignor ? "Wysłana do Ciebie" : "Oddana komisantowi", detail: null, tone: "slate" };
    case "shipment_requested":
      return { title: "Zlecono wysyłkę do komisanta", detail: null, tone: "amber" };
    case "shipment_cancelled":
      return { title: "Zlecenie wysyłki anulowane", detail: null, tone: "slate" };
    case "payout":
      return d.paid ? { title: "Wypłacono", detail: [pln(d.amount), typeof d.title === "string" && d.title ? `tytuł: ${d.title}` : null].filter(Boolean).join(" · ") || null, tone: "green" }
        : { title: "Cofnięto wypłatę", detail: null, tone: "slate" };
    case "price":
      return { title: "Zmiana ceny w sklepie", detail: [pln(d.price), d.compare_at_price ? `przed obniżką ${pln(d.compare_at_price)}` : null].filter(Boolean).join(" · ") || null, tone: "blue" };
    case "edited": {
      const parts: string[] = [];
      if ("payout_amount" in d) parts.push(`kwota komisanta: ${pln(d.payout_amount) ?? "–"}`);
      if (!forConsignor && "purchase_price" in d) parts.push(`cena zakupu: ${pln(d.purchase_price) ?? "–"}`);
      if (!forConsignor && "shelf" in d) parts.push(`półka: ${d.shelf ?? "–"}`);
      if (!forConsignor && "identifier" in d) parts.push(`IMEI / nr: ${d.identifier ?? "–"}`);
      if (forConsignor && !parts.length) return { title: "Zaktualizowano dane rzeczy", detail: null, tone: "slate" };
      return { title: forConsignor && "payout_amount" in d ? "Zmieniona Twoja kwota" : "Edycja danych", detail: parts.join(" · ") || null, tone: "slate" };
    }
    default:
      return { title: e.type, detail: null, tone: "slate" };
  }
}

export type TimelineRow = HistoryEvent & { unitId: string | null; label: string; code: string | null };

type Db = import("@supabase/supabase-js").SupabaseClient;

/**
 * Historia rzeczy komisanta: zdarzenia jego sztuk, zmiany ceny w sklepie (od przyjęcia) i wypłaty – od najnowszych.
 */
export async function consignorTimeline(db: Db, consignorId: string, units: { id: string; code: string; title: string; option: string; status: string; received_at: string }[], limit = 300): Promise<TimelineRow[]> {
  const byId = new Map(units.map((u) => [u.id, u]));
  const ids = units.map((u) => u.id);
  const events: TimelineRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("unit_events").select("unit_id, type, data, created_at").in("unit_id", ids.slice(i, i + 200)).order("created_at", { ascending: false }).limit(limit);
    for (const e of data ?? []) {
      const u = byId.get(e.unit_id as string);
      events.push({ type: e.type as string, data: e.data as Record<string, unknown> | null, created_at: e.created_at as string, unitId: e.unit_id as string, label: u ? `${u.title} · ${u.option}` : "", code: u?.code ?? null });
    }
  }
  // Ceny w sklepie rzeczy jeszcze w komisie (od dnia przyjęcia).
  const live = units.filter((u) => ["in_stock", "reserved", "in_transit", "consignor_hold"].includes(u.status));
  if (live.length) {
    const { data: vu } = await db.from("units").select("id, variant_id, location:locations(store_id)").in("id", live.map((u) => u.id).slice(0, 300));
    for (const r of (vu ?? []) as unknown as { id: string; variant_id: string; location: { store_id: string } | null }[]) {
      const u = byId.get(r.id)!;
      const { data: ph } = await db.from("variant_price_history").select("price, compare_at_price, valid_from").eq("variant_id", r.variant_id)
        .eq("store_id", r.location?.store_id ?? "").gte("valid_from", u.received_at).order("valid_from", { ascending: false }).limit(10);
      for (const p of ph ?? []) events.push({ type: "price", data: { price: Number(p.price), compare_at_price: p.compare_at_price === null ? null : Number(p.compare_at_price) }, created_at: p.valid_from as string, unitId: u.id, label: `${u.title} · ${u.option}`, code: u.code });
    }
  }
  const { data: payouts } = await db.from("consignor_payouts").select("amount, note, paid_at, created_at, unit_ids").eq("consignor_id", consignorId).order("created_at", { ascending: false }).limit(100);
  for (const p of payouts ?? []) {
    if (((p.unit_ids as string[] | null) ?? []).length) continue; // wypłata za konkretną rzecz jest już w zdarzeniach sztuki
    events.push({ type: "payout", data: { paid: true, amount: Number(p.amount), title: p.note }, created_at: (p.paid_at as string) ?? (p.created_at as string), unitId: null, label: "Wypłata", code: null });
  }
  return events.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}
