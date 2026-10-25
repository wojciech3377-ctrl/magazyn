"use server";

import { forgetConsignorLink } from "@/lib/consignor-link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { adjustStock } from "@/lib/stock";
import { errorMessage } from "@/lib/errors";
import { mailConsignorAccount } from "@/lib/staff-mail";

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
/** Konto pracownika (ma profil) – nie usuwamy go ani nie zmieniamy mu hasła z poziomu komisanta. */
async function isStaffAccount(db: ReturnType<typeof createAdminClient>, userId: string) {
  const { data } = await db.from("profiles").select("id").eq("id", userId).maybeSingle();
  return !!data;
}

export async function createConsignorAccount(formData: FormData) {
  await requireAdmin();
  const id = s(formData, "id");
  const email = s(formData, "email").toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) back(id, "Podaj e-mail komisanta.", false);
  const db = createAdminClient();
  const { data: c } = await db.from("consignors").select("id, user_id, name").eq("id", id).maybeSingle();
  if (!c) back(id, "Nie ma takiego komisanta.", false);
  if (c!.user_id) back(id, "Ten komisant ma już konto.", false);
  // Pracownik może być też komisantem: to samo konto (ten sam e-mail i hasło) dostaje dostęp do panelu komisanta.
  const { data: staff } = await db.from("profiles").select("id").ilike("email", email).maybeSingle();
  if (staff) {
    const { data: taken } = await db.from("consignors").select("name").eq("user_id", staff.id).neq("id", id).maybeSingle();
    if (taken) back(id, `To konto pracownika jest już połączone z komisantem ${taken.name}.`, false);
    await db.from("consignors").update({ user_id: staff.id, email }).eq("id", id);
    await db.from("consignors").update({ must_change_password: false }).eq("id", id);
    forgetConsignorLink(staff.id);
    const mail = await mailConsignorAccount(db, "linked", email, null, c!.name as string);
    revalidatePath(`/komisanci/${id}`);
    back(id, `Połączono z kontem pracownika ${email}. Po zalogowaniu swoim hasłem ma w menu „Mój komis” – panel komisanta (hasło startowe nie jest potrzebne). ${mail}`);
  }
  if (password.length < 10) back(id, "Podaj hasło startowe (min. 10 znaków).", false);
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { kind: "consignor", consignor_id: id } });
  if (error || !data.user) back(id, /already|registered|exists/i.test(error?.message ?? "") ? "Konto z tym e-mailem już istnieje (np. komisant u innego wpisu) – użyj innego adresu albo odepnij stare konto." : `Nie udało się utworzyć konta: ${error?.message ?? "błąd"}`, false);
  await db.from("consignors").update({ user_id: data.user!.id, email: email }).eq("id", id);
  // Przy pierwszym logowaniu komisant ustawia własne hasło (bez migracji 0039 – pomijamy).
  await db.from("consignors").update({ must_change_password: true }).eq("id", id);
  const mail = await mailConsignorAccount(db, "new", email, password, c!.name as string);
  revalidatePath(`/komisanci/${id}`);
  back(id, `Konto ${email} utworzone. ${mail} Przy pierwszym logowaniu komisant ustawi własne hasło.`, !/nie wysłany/.test(mail));
}

/** Zablokowanie dostępu: konto komisanta jest usuwane (dane i historia komisu zostają). */
export async function removeConsignorAccount(formData: FormData) {
  await requireAdmin();
  const id = s(formData, "id");
  const db = createAdminClient();
  const { data: c } = await db.from("consignors").select("user_id").eq("id", id).maybeSingle();
  if (!c?.user_id) back(id, "Komisant nie ma konta.", false);
  await db.from("consignors").update({ user_id: null }).eq("id", id);
  forgetConsignorLink(c!.user_id as string);
  // Konto pracownika zostaje – tylko traci dostęp do panelu komisanta.
  if (await isStaffAccount(db, c!.user_id as string)) back(id, "Dostęp do panelu komisanta odebrany (konto pracownika zostaje).");
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
  const { data: c } = await db.from("consignors").select("user_id, email, name").eq("id", id).maybeSingle();
  if (!c?.user_id) back(id, "Komisant nie ma konta.", false);
  if (await isStaffAccount(db, c!.user_id as string)) back(id, "To konto pracownika – hasło zmienia się w Pracownicy (albo pracownik sam, w swoim profilu).", false);
  const { error } = await db.auth.admin.updateUserById(c!.user_id as string, { password });
  if (error) back(id, error.message, false);
  await db.from("consignors").update({ must_change_password: true }).eq("id", id);
  // Adres logowania – z konta (e-mail w danych komisanta mógł się zmienić).
  const { data: u } = await db.auth.admin.getUserById(c!.user_id as string);
  const to = u?.user?.email ?? (c!.email as string | null);
  const mail = to ? await mailConsignorAccount(db, "reset", to, password, c!.name as string) : "E-mail nie wysłany – brak adresu e-mail.";
  back(id, `Hasło tymczasowe ustawione – komisant po zalogowaniu ustawi własne hasło. ${mail}`, !/nie wysłany/.test(mail));
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
  // Zamiar z formularza: drugie kliknięcie / odświeżenie nie cofa właśnie zapisanej wypłaty (i odwrotnie).
  const want = s(formData, "want");
  if (want === "1" && u!.consignor_payout_id) back(id, `${u!.code} jest już oznaczona jako zapłacona.`);
  if (want === "0" && !u!.consignor_payout_id) back(id, `${u!.code} nie jest oznaczona jako zapłacona.`);
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
  // Tylko gdy rzecz nadal nie ma wypłaty (dwa równoczesne kliknięcia nie tworzą dwóch wypłat).
  const { data: claimed } = await db.from("units").update({ consignor_payout_id: payout!.id }).eq("id", unitId).is("consignor_payout_id", null).select("id");
  if (!claimed?.length) {
    await db.from("consignor_payouts").delete().eq("id", payout!.id);
    back(id, `${u!.code} jest już oznaczona jako zapłacona.`);
  }
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
  if (c?.user_id && !(await isStaffAccount(db, c.user_id as string))) await db.auth.admin.deleteUser(c.user_id as string).catch(() => null);
  revalidatePath("/komisanci");
  redirect(`/komisanci?ok=${encodeURIComponent(`Komisant ${c?.name ?? ""} usunięty.`)}`);
}

export type OwnUnitHit = { id: string; code: string; title: string; option: string; identifier: string | null; location: string; price: number | null };

/** Sztuki własne na stanie (do dopisania komisantowi) – po kodzie, IMEI albo nazwie. */
export async function searchOwnUnitsForConsignor(q: string): Promise<OwnUnitHit[]> {
  const { supabase } = await requireSection("komisanci");
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim().slice(0, 80);
  if (text.length < 2) return [];
  const sel = "id, code, identifier, location:locations(name, store_id), variant:variants(option, links:variant_store_links(store_id, price), product:products(title))";
  const code = text.toUpperCase();
  const { findVariantIds } = await import("@/lib/queries/units");
  const [byCode, vids] = await Promise.all([
    supabase.from("units").select(sel).or(`code.eq.${code.replace(/[^A-Z0-9_.-]/g, "")},identifier.eq.${code.replace(/[^A-Z0-9_.-]/g, "")}`).eq("owner_type", "own").in("status", ["in_stock", "in_transit", "reserved"]).limit(5),
    findVariantIds(supabase, text),
  ]);
  const { data: byName } = vids.length
    ? await supabase.from("units").select(sel).in("variant_id", vids.slice(0, 150)).eq("owner_type", "own").in("status", ["in_stock", "in_transit", "reserved"]).order("received_at").limit(40)
    : { data: [] };
  type R = { id: string; code: string; identifier: string | null; location: { name: string; store_id: string }; variant: { option: string; links: { store_id: string; price: number | null }[]; product: { title: string } } };
  const all = [...((byCode.data ?? []) as unknown as R[]), ...((byName ?? []) as unknown as R[])];
  return [...new Map(all.map((u) => [u.id, {
    id: u.id, code: u.code, identifier: u.identifier, title: u.variant.product.title, option: u.variant.option, location: u.location.name,
    price: u.variant.links.find((l) => l.store_id === u.location.store_id)?.price ?? null,
  }])).values()];
}

/** Dopisanie komisantowi sztuk z magazynu: stają się rzeczami w komisie z kwotą dla komisanta. */
export async function assignUnitsToConsignor(_: { error?: string } | null, fd: FormData): Promise<{ error?: string }> {
  const { profile } = await requireSection("komisanci");
  const id = s(fd, "id");
  if (!/^[0-9a-f-]{36}$/.test(id)) return { error: "Zły komisant." };
  let rows: { unit_id: string; payout: string }[] = [];
  try { rows = JSON.parse(s(fd, "units") || "[]"); } catch { return { error: "Błąd listy rzeczy." }; }
  rows = rows.filter((r) => /^[0-9a-f-]{36}$/.test(String(r.unit_id))).slice(0, 100);
  if (!rows.length) return { error: "Wybierz rzeczy z magazynu." };
  const db = createAdminClient();
  const { data: c } = await db.from("consignors").select("id, name").eq("id", id).maybeSingle();
  if (!c) return { error: "Nie ma takiego komisanta." };
  let n = 0;
  for (const r of rows) {
    const payout = String(r.payout ?? "").trim() ? Math.round(Number(String(r.payout).replace(/\s/g, "").replace(",", ".")) * 100) / 100 : null;
    if (payout !== null && (!Number.isFinite(payout) || payout < 0)) return { error: "Podaj poprawną kwotę dla komisanta." };
    const { data: done } = await db.from("units").update({ owner_type: "consignment", consignor_id: id, ...(payout !== null ? { payout_amount: payout } : {}) })
      .eq("id", r.unit_id).eq("owner_type", "own").select("id");
    if (done?.length) {
      n++;
      await db.from("unit_events").insert({ unit_id: r.unit_id, type: "owner", data: { to: "consignment", consignor_id: id, consignor: c.name, payout, by: profile.id, note: "dopisane komisantowi z magazynu" } });
    }
  }
  revalidatePath(`/komisanci/${id}`);
  back(id, n ? `Dopisano komisantowi ${n} szt. z magazynu.` : "Nic nie dopisano – rzeczy są już w komisie albo nie są własne.", n > 0);
  return {};
}
