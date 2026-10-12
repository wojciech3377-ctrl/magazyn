"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { adjustStock } from "@/lib/stock";
import { errorMessage } from "@/lib/errors";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const back = (id: string, msg: string, ok = true): never => redirect(`/komisanci/${id}?${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);

export async function saveConsignor(formData: FormData) {
  const { supabase } = await requireSection("komisanci");
  const id = s(formData, "id");
  const row = {
    name: s(formData, "name"),
    email: s(formData, "email") || null,
    phone: s(formData, "phone") || null,
    bank_account: s(formData, "bank_account").replace(/\s/g, "") || null,
    notes: s(formData, "notes") || null,
    ...(formData.has("address_street") ? {
      address_name: s(formData, "address_name") || null,
      address_street: s(formData, "address_street") || null,
      address_postcode: s(formData, "address_postcode") || null,
      address_city: s(formData, "address_city") || null,
      address_country: (s(formData, "address_country") || "PL").toUpperCase().slice(0, 2),
      address_phone: s(formData, "address_phone") || null,
    } : {}),
  };
  if (!row.name) return;
  if (id) await supabase.from("consignors").update(row).eq("id", id);
  else await supabase.from("consignors").insert(row);
  revalidatePath("/komisanci");
  if (id) back(id, "Dane komisanta zapisane.");
}

/** Konto do panelu komisanta (logowanie e-mailem i hasłem startowym). */
export async function createConsignorAccount(formData: FormData) {
  await requireAdmin();
  const id = s(formData, "id");
  const email = s(formData, "email").toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 10) back(id, "Podaj e-mail i hasło startowe (min. 10 znaków).", false);
  const db = createAdminClient();
  const { data: c } = await db.from("consignors").select("id, user_id").eq("id", id).maybeSingle();
  if (!c) back(id, "Nie ma takiego komisanta.", false);
  if (c!.user_id) back(id, "Ten komisant ma już konto.", false);
  const { data: staff } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
  if (staff) back(id, "Ten e-mail należy do konta pracownika – użyj innego adresu dla komisanta.", false);
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { kind: "consignor", consignor_id: id } });
  if (error || !data.user) back(id, `Nie udało się utworzyć konta: ${error?.message ?? "błąd"}`, false);
  await db.from("consignors").update({ user_id: data.user!.id, email: email }).eq("id", id);
  // Przy pierwszym logowaniu komisant ustawia własne hasło (bez migracji 0039 – pomijamy).
  await db.from("consignors").update({ must_change_password: true }).eq("id", id);
  revalidatePath(`/komisanci/${id}`);
  back(id, `Konto ${email} utworzone. Przekaż komisantowi adres aplikacji i hasło startowe – przy pierwszym logowaniu ustawi własne hasło.`);
}

/** Zablokowanie dostępu: konto komisanta jest usuwane (dane i historia komisu zostają). */
export async function removeConsignorAccount(formData: FormData) {
  await requireAdmin();
  const id = s(formData, "id");
  const db = createAdminClient();
  const { data: c } = await db.from("consignors").select("user_id").eq("id", id).maybeSingle();
  if (!c?.user_id) back(id, "Komisant nie ma konta.", false);
  await db.from("consignors").update({ user_id: null }).eq("id", id);
  const { error } = await db.auth.admin.deleteUser(c!.user_id as string);
  if (error) back(id, `Konto odpięte, ale nie usunięte: ${error.message}`, false);
  back(id, "Dostęp do panelu komisanta zablokowany (konto usunięte).");
}

export async function resetConsignorPassword(formData: FormData) {
  await requireAdmin();
  const id = s(formData, "id");
  const password = String(formData.get("password") ?? "");
  if (password.length < 10) back(id, "Hasło musi mieć min. 10 znaków.", false);
  const db = createAdminClient();
  const { data: c } = await db.from("consignors").select("user_id").eq("id", id).maybeSingle();
  if (!c?.user_id) back(id, "Komisant nie ma konta.", false);
  const { error } = await db.auth.admin.updateUserById(c!.user_id as string, { password });
  if (error) back(id, error.message, false);
  await db.from("consignors").update({ must_change_password: true }).eq("id", id);
  back(id, "Hasło tymczasowe ustawione – komisant po zalogowaniu ustawi własne hasło.");
}

/** Wypłata dla komisanta (przelew) – zmniejsza kwotę do wypłaty. Kwota ujemna = korekta. */
export async function addPayout(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = s(formData, "id");
  const amount = Math.round(Number(s(formData, "amount").replace(/\s/g, "").replace(",", ".")) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0) back(id, "Podaj kwotę wypłaty.", false);
  const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(s(formData, "paid_at")) ? s(formData, "paid_at") : new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from("consignor_payouts").insert({ consignor_id: id, amount, paid_at: paidAt, note: s(formData, "note") || null });
  if (error) back(id, error.message, false);
  revalidatePath(`/komisanci/${id}`);
  back(id, `Zapisano wypłatę ${amount.toFixed(2)} zł.`);
}

export async function deletePayout(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = s(formData, "id");
  await supabase.from("consignor_payouts").delete().eq("id", s(formData, "payout_id")).eq("consignor_id", id);
  revalidatePath(`/komisanci/${id}`);
  back(id, "Wypłata usunięta.");
}

/** Zlecenie wysyłki do komisanta: wysłane (rzeczy wychodzą z magazynu) albo anulowane (wracają na stan). */
export async function processShipment(formData: FormData) {
  const { supabase, profile } = await requireSection("komisanci");
  const id = s(formData, "id");
  const shipmentId = s(formData, "shipment_id");
  const op = s(formData, "op");
  const db = createAdminClient();
  if (!["shipped", "cancel"].includes(op)) back(id, "Nieznana operacja.", false);
  // Najpierw przejęcie zlecenia (tylko „zlecone”) – równoległe anulowanie przez komisanta albo drugi klik nic nie zepsują.
  const { data: sh } = await db.from("consignor_shipments")
    .update({ status: op === "shipped" ? "shipped" : "cancelled", tracking: op === "shipped" ? s(formData, "tracking") || null : null, processed_at: new Date().toISOString(), processed_by: profile.id })
    .eq("id", shipmentId).eq("consignor_id", id).eq("status", "requested").select("unit_ids").maybeSingle();
  if (!sh) back(id, "To zlecenie jest już obsłużone.", false);
  try {
    if (op === "shipped") {
      const { data: units } = await db.from("units").update({ status: "consignor_returned" })
        .in("id", sh!.unit_ids as string[]).eq("status", "consignor_hold").select("id");
      await supabase.from("unit_events").insert((units ?? []).map((u) => ({ unit_id: u.id, type: "consignor_returned", data: { shipment_id: shipmentId, tracking: s(formData, "tracking") || null } })));
      revalidatePath(`/komisanci/${id}`);
      revalidatePath("/magazyn");
      back(id, `Wysyłka zapisana – ${units?.length ?? 0} szt. wyszło z magazynu.`);
    }
    if (op === "cancel") {
      const { data: units } = await db.from("units").update({ status: "in_stock" })
        .in("id", sh!.unit_ids as string[]).eq("status", "consignor_hold").select("id, variant_id, location_id");
      await supabase.from("unit_events").insert((units ?? []).map((u) => ({ unit_id: u.id, type: "shipment_cancelled", data: { shipment_id: shipmentId } })));
      await adjustStock(supabase, (units ?? []).map((u) => ({ variantId: u.variant_id as string, locationId: u.location_id as string, delta: 1 })));
      revalidatePath(`/komisanci/${id}`);
      back(id, "Zlecenie anulowane – rzeczy wróciły na stan.");
    }
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    back(id, errorMessage(e), false);
  }
  back(id, "Nieznana operacja.", false);
}

/** Pobranie etykiety dołączonej przez komisanta (link ważny 5 minut). */
export async function openLabel(formData: FormData) {
  await requireSection("komisanci");
  const db = createAdminClient();
  const { data: sh } = await db.from("consignor_shipments").select("label_path, consignor_id").eq("id", s(formData, "shipment_id")).maybeSingle();
  if (!sh?.label_path) back(s(formData, "id"), "Brak etykiety.", false);
  const { data } = await db.storage.from("consignor-labels").createSignedUrl(sh!.label_path as string, 300);
  if (!data?.signedUrl) back(s(formData, "id"), "Nie udało się otworzyć etykiety.", false);
  redirect(data!.signedUrl);
}

export async function saveConsignmentFee(formData: FormData) {
  const { supabase } = await requireAdmin();
  const fee = Math.round(Number(s(formData, "fee").replace(",", ".")) * 100) / 100;
  if (!Number.isFinite(fee) || fee < 0) redirect(`/komisanci?blad=${encodeURIComponent("Podaj opłatę za wysyłkę.")}`);
  await supabase.from("app_settings").upsert({ key: "consignment", value: { shipping_fee: fee }, updated_at: new Date().toISOString() });
  revalidatePath("/komisanci");
  redirect(`/komisanci?ok=${encodeURIComponent("Opłata zapisana.")}`);
}

/** Rzecz komisanta rozliczona: wypłata na jej kwotę (tytuł = numer umowy) albo cofnięcie. */
export async function toggleUnitPaid(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = s(formData, "id");
  const unitId = s(formData, "unit_id");
  const db = createAdminClient();
  const { data: u } = await db.from("units").select("id, code, payout_amount, consignor_payout_id, consignor_id, status, contract:contracts(number, doc_number, template), variant:variants(option, product:products(title))").eq("id", unitId).eq("consignor_id", id).maybeSingle();
  if (!u) back(id, "Nie ma takiej rzeczy.", false);
  if (u!.consignor_payout_id) {
    await supabase.from("consignor_payouts").delete().eq("id", u!.consignor_payout_id).eq("consignor_id", id);
    await db.from("units").update({ consignor_payout_id: null }).eq("id", unitId);
    await db.from("unit_events").insert({ unit_id: unitId, type: "payout", data: { paid: false } });
    revalidatePath(`/komisanci/${id}`);
    back(id, `Cofnięto „zapłacono” dla ${u!.code}.`);
  }
  const amount = Number(u!.payout_amount ?? 0);
  if (!(amount > 0)) back(id, "Ta rzecz nie ma kwoty komisanta.", false);
  const c = u!.contract as unknown as { number: number | null; doc_number: string | null; template: string | null } | null;
  const v = u!.variant as unknown as { option: string; product: { title: string } } | null;
  const title = c ? (c.template && c.number ? `NR${c.number}` : c.doc_number ?? (c.number ? `NR${c.number}` : "")) : "";
  const { data: payout, error } = await supabase.from("consignor_payouts").insert({
    consignor_id: id, amount, note: [title, v ? `${v.product.title} ${v.option}` : u!.code].filter(Boolean).join(" – ").slice(0, 300), unit_ids: [unitId],
  }).select("id").single();
  if (error || !payout) back(id, errorMessage(error), false);
  await db.from("units").update({ consignor_payout_id: payout!.id }).eq("id", unitId);
  await db.from("unit_events").insert({ unit_id: unitId, type: "payout", data: { paid: true, amount, title, payout_id: payout!.id } });
  revalidatePath(`/komisanci/${id}`);
  back(id, `Zapłacono ${amount.toFixed(2)} zł${title ? ` (tytuł: ${title})` : ""}.`);
}

/** Usunięcie komisanta (tylko bez rzeczy w aplikacji); konto do panelu też jest usuwane. */
export async function deleteConsignor(formData: FormData) {
  await requireAdmin();
  const id = s(formData, "id");
  const db = createAdminClient();
  const { count } = await db.from("units").select("id", { count: "exact", head: true }).eq("consignor_id", id);
  if (count) back(id, `Komisant ma ${count} rzeczy w historii magazynu – nie można go usunąć (dane są potrzebne do rozliczeń i JPK).`, false);
  const { data: c } = await db.from("consignors").select("user_id, name").eq("id", id).maybeSingle();
  await db.from("contracts").update({ consignor_id: null }).eq("consignor_id", id);
  const { error } = await db.from("consignors").delete().eq("id", id);
  if (error) back(id, error.message, false);
  if (c?.user_id) await db.auth.admin.deleteUser(c.user_id as string).catch(() => null);
  revalidatePath("/komisanci");
  redirect(`/komisanci?ok=${encodeURIComponent(`Komisant ${c?.name ?? ""} usunięty.`)}`);
}
