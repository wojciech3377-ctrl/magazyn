"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireConsignor, consignmentFee, defaultAddress, labelFileType, type Consignor, type ShipAddress } from "@/lib/consignment";
import { signUploadPath, uploadedFile } from "@/lib/contracts/upload";
import { escapeHtml } from "@/lib/contracts/png";
import { contractTotal } from "@/lib/contracts/purchase";
import { adjustStock } from "@/lib/stock";
import { getCompany } from "@/lib/contracts/settings";
import { mailConfigured, sendMail } from "@/lib/mail";
import { errorMessage } from "@/lib/errors";

export type ShipState = { ok?: string; error?: string } | null;

const LABEL_PATH = (consignorId: string) => new RegExp(`^${consignorId}/[0-9a-f-]{36}\\.(pdf|jpg|png)$`);

/** Adres do wgrania własnej etykiety prosto do magazynu plików (z pominięciem limitu wielkości żądania). */
export async function prepareLabelUpload(fileName: string, size: number): Promise<{ path: string; token: string } | { error: string }> {
  const { db, consignor } = await requireConsignor();
  const ext = (fileName.split(".").pop() ?? "").toLowerCase().replace("jpeg", "jpg");
  if (!["pdf", "jpg", "png"].includes(ext)) return { error: "Etykieta musi być plikiem PDF, JPG albo PNG." };
  if (!(size > 0) || size > 10 * 1024 * 1024) return { error: "Plik może mieć najwyżej 10 MB." };
  const path = `${consignor.id}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await db.storage.from("consignor-labels").createSignedUploadUrl(path);
  if (error || !data) return { error: `Nie można przygotować wgrania pliku: ${error?.message ?? "błąd"}` };
  return { path, token: data.token };
}

/** Zlecenie wysyłki wybranych rzeczy do komisanta: na adres z konta, na inny adres (płatna) albo z własną etykietą. */
export async function requestShipment(_: ShipState, fd: FormData): Promise<ShipState> {
  const { db, consignor } = await requireConsignor();
  const ids = [...new Set(fd.getAll("unit").map(String).filter((x) => /^[0-9a-f-]{36}$/.test(x)))];
  if (!ids.length) return { error: "Zaznacz rzeczy do wysyłki." };
  const method = String(fd.get("method") ?? "default") as "default" | "custom" | "own_label";
  if (!["default", "custom", "own_label"].includes(method)) return { error: "Wybierz sposób wysyłki." };
  const s = (k: string) => String(fd.get(k) ?? "").trim();

  let address: ShipAddress | null = null;
  let fee: number | null = null;
  let labelPath: string | null = null;
  let labelName: string | null = null;
  if (method === "default") {
    address = defaultAddress(consignor);
    if (!address) return { error: "Twoje konto nie ma adresu do wysyłki – wybierz inny adres albo napisz do nas." };
  } else if (method === "custom") {
    address = { name: s("name"), street: s("street"), postcode: s("postcode"), city: s("city"), country: (s("country") || "PL").toUpperCase().slice(0, 2), phone: s("phone") };
    if (!address.name || !address.street || !address.postcode || !address.city || !address.phone) return { error: "Uzupełnij adres i telefon odbiorcy." };
    fee = await consignmentFee(db);
  } else {
    labelPath = s("label_path");
    labelName = s("label_name").slice(0, 200) || null;
    if (!LABEL_PATH(consignor.id).test(labelPath)) return { error: "Dołącz plik etykiety (PDF, JPG albo PNG)." };
    const { data: file, error } = await db.storage.from("consignor-labels").download(labelPath);
    if (error || !file) return { error: "Nie znalazłem wgranej etykiety – dołącz ją ponownie." };
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024 || !labelFileType(buf)) {
      await db.storage.from("consignor-labels").remove([labelPath]);
      return { error: "Etykieta musi być prawdziwym plikiem PDF, JPG albo PNG (do 10 MB)." };
    }
  }

  // Tylko rzeczy tego komisanta, które są na stanie – od razu zarezerwowane (nie sprzedamy ich w międzyczasie).
  const { data: reserved, error: rErr } = await db.from("units").update({ status: "consignor_hold" })
    .in("id", ids).eq("owner_type", "consignment").eq("consignor_id", consignor.id).eq("status", "in_stock")
    .select("id, code, variant_id, location_id");
  if (rErr) return { error: errorMessage(rErr) };
  if (!reserved?.length) return { error: "Żadna z zaznaczonych rzeczy nie jest już na stanie." };

  const { data: shipment, error: sErr } = await db.from("consignor_shipments").insert({
    consignor_id: consignor.id, method, address, unit_ids: reserved.map((u) => u.id), label_path: labelPath, label_name: labelName,
    shipping_fee: fee, note: s("note").slice(0, 500) || null,
  }).select("id").single();
  if (sErr || !shipment) {
    await db.from("units").update({ status: "in_stock" }).in("id", reserved.map((u) => u.id)).eq("status", "consignor_hold");
    return { error: errorMessage(sErr ?? new Error("nie zapisano zlecenia")) };
  }
  await db.from("unit_events").insert(reserved.map((u) => ({ unit_id: u.id, type: "shipment_requested", data: { shipment_id: shipment.id, method, by: "komisant" } })));
  // Odłożona rzecz nie jest już do kupienia w sklepie.
  const stock = await adjustStock(db, reserved.map((u) => ({ variantId: u.variant_id as string, locationId: u.location_id as string, delta: -1 })));
  const stockFailed = stock.filter((r) => !r.ok);
  if (stockFailed.length) await db.from("consignor_shipments").update({ note: [s("note").slice(0, 400), `UWAGA: stan w Shopify nie zmieniony (${stockFailed.map((f) => f.message).join("; ").slice(0, 300)})`].filter(Boolean).join(" · ") }).eq("id", shipment.id);

  try {
    if (await mailConfigured()) {
      const company = await getCompany(db);
      if (company.email) {
        await sendMail(company.email, `Komis: ${consignor.name} zleca wysyłkę ${reserved.length} szt.`,
          `<p>Komisant <b>${escapeHtml(consignor.name)}</b> zlecił wysyłkę: ${reserved.map((u) => u.code).join(", ")}.</p><p>Sposób: ${method === "default" ? "adres z konta" : method === "custom" ? `inny adres (opłata ${fee} zł – wystaw fakturę)` : "własna etykieta (w załączniku zlecenia)"}.</p><p>Obsłuż w aplikacji: Komisanci → ${escapeHtml(consignor.name)}.</p>`);
      }
    }
  } catch {
    // powiadomienie nie jest konieczne – zlecenie jest zapisane
  }
  revalidatePath("/komis");
  return { ok: `Zlecenie wysyłki przyjęte (${reserved.length} szt.).${reserved.length < ids.length ? ` ${ids.length - reserved.length} szt. nie było już na stanie.` : ""}${fee ? ` Opłata za wysyłkę: ${fee.toFixed(2)} zł – wystawimy fakturę.` : ""}` };
}

/** Komisant anuluje swoje zlecenie, dopóki go nie wysłaliśmy. */
export async function cancelShipmentByConsignor(fd: FormData) {
  const { db, consignor } = await requireConsignor();
  const id = String(fd.get("id") ?? "");
  const { data: sh } = await db.from("consignor_shipments").update({ status: "cancelled", processed_at: new Date().toISOString() })
    .eq("id", id).eq("consignor_id", consignor.id).eq("status", "requested").select("unit_ids").maybeSingle();
  if (sh) {
    const { data: back } = await db.from("units").update({ status: "in_stock" })
      .in("id", sh.unit_ids as string[]).eq("consignor_id", consignor.id).eq("status", "consignor_hold").select("id, variant_id, location_id");
    if (back?.length) {
      await db.from("unit_events").insert(back.map((u) => ({ unit_id: u.id, type: "shipment_cancelled", data: { shipment_id: id, by: "komisant" } })));
      await adjustStock(db, back.map((u) => ({ variantId: u.variant_id as string, locationId: u.location_id as string, delta: 1 })));
    }
  }
  revalidatePath("/komis");
}

export type DocState = { ok?: string; error?: string } | null;

type Sold = { id: string; code: string; identifier: string | null; payout_amount: number | null; contract_id: string | null; variant: { option: string; product: { title: string } } | null };

/**
 * Zaznaczone sprzedane rzeczy komisanta bez umowy. Wcześniej zaczęte (niepodpisane) umowy z panelu,
 * którym minął termin linku, są anulowane – rzecz wraca do „bez umowy”.
 */
async function soldWithoutContract(db: SupabaseClient, consignor: Consignor, fd: FormData) {
  const ids = [...new Set(fd.getAll("sold").map(String).filter((x) => /^[0-9a-f-]{36}$/.test(x)))].slice(0, 100);
  if (!ids.length) return { error: "Zaznacz sprzedane rzeczy." };
  const { data: stale } = await db.from("units").select("contract:contracts(id, status, source, sign_expires_at)")
    .in("id", ids).eq("consignor_id", consignor.id).not("contract_id", "is", null);
  // Niepodpisana umowa komisanta (także wysłana automatycznie po sprzedaży) ustępuje nowemu dokumentowi:
  // zaznaczone rzeczy z niej wypadają, a pusta umowa jest anulowana.
  const seen = new Set<string>();
  for (const u of stale ?? []) {
    const c = u.contract as unknown as { id: string; status: string; source: string | null; sign_expires_at: string | null } | null;
    if (!c || seen.has(c.id) || c.source !== "consignor" || c.status !== "sent") continue;
    seen.add(c.id);
    const { data: full } = await db.from("contracts").select("items").eq("id", c.id).eq("status", "sent").maybeSingle();
    if (!full) continue;
    const rest = ((full.items ?? []) as { unit_id?: string; qty?: number; price?: number }[]).filter((i) => !i.unit_id || !ids.includes(i.unit_id));
    if (!rest.length) {
      const { data: done } = await db.from("contracts").update({ status: "cancelled" }).eq("id", c.id).eq("status", "sent").select("id");
      if (done?.length) await db.from("units").update({ contract_id: null }).eq("contract_id", c.id);
    } else {
      const { data: done } = await db.from("contracts").update({ items: rest, amount: contractTotal(rest as never) }).eq("id", c.id).eq("status", "sent").select("id");
      if (done?.length) await db.from("units").update({ contract_id: null }).eq("contract_id", c.id).in("id", ids);
    }
  }
  const { data } = await db.from("units").select("id, code, identifier, payout_amount, contract_id, variant:variants(option, product:products(title))")
    .in("id", ids).eq("consignor_id", consignor.id).eq("owner_type", "consignment").in("status", ["sold", "shipped"]).is("contract_id", null);
  const units = (data ?? []) as unknown as Sold[];
  if (!units.length) return { error: "Zaznaczone rzeczy mają już umowę albo fakturę." };
  const noPrice = units.filter((u) => u.payout_amount === null || Number(u.payout_amount) <= 0);
  if (noPrice.length) return { error: `Brak Twojej kwoty dla: ${noPrice.map((u) => u.code).join(", ")} – napisz do nas, uzupełnimy ją.` };
  return { units, skipped: ids.length - units.length };
}

const itemsOf = (units: Sold[]) => units.map((u) => ({
  unit_id: u.id, title: u.variant?.product.title ?? u.code, option: u.variant?.option ?? "–", identifier: u.identifier, qty: 1, price: Math.round(Number(u.payout_amount) * 100) / 100,
}));

/** Przypięcie umowy do rzeczy (tylko tych jeszcze bez umowy); pozycje umowy = rzeczy faktycznie przypięte. */
async function bindUnits(db: SupabaseClient, contractId: string, units: Sold[], event: Record<string, unknown>) {
  const { data: bound } = await db.from("units").update({ contract_id: contractId }).in("id", units.map((u) => u.id)).is("contract_id", null).select("id");
  const got = new Set((bound ?? []).map((u) => u.id as string));
  const kept = units.filter((u) => got.has(u.id));
  if (kept.length && kept.length < units.length) {
    const items = itemsOf(kept);
    await db.from("contracts").update({ items, amount: contractTotal(items) }).eq("id", contractId);
  }
  if (kept.length) await db.from("unit_events").insert(kept.map((u) => ({ unit_id: u.id, type: "contract", data: { contract_id: contractId, by: "komisant", ...event } })));
  return kept;
}

async function tellCompany(db: SupabaseClient, subject: string, html: string) {
  try {
    if (!(await mailConfigured())) return;
    const company = await getCompany(db);
    if (company.email) await sendMail(company.email, subject, html);
  } catch {
    // powiadomienie nie jest konieczne
  }
}

/** Komisant wypełnia i podpisuje umowę kupna do sprzedanych rzeczy (ten sam formularz co link do podpisu). */
export async function createConsignorContract(_: DocState, fd: FormData): Promise<DocState> {
  const { db, consignor } = await requireConsignor();
  const r = await soldWithoutContract(db, consignor, fd);
  if ("error" in r) return { error: r.error };
  const company = await getCompany(db);
  const items = itemsOf(r.units);
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { data: c, error } = await db.from("contracts").insert({
    type: "purchase",
    template: "purchase_v1",
    source: "consignor",
    status: "sent",
    currency: "PLN", // kwoty komisu są w złotych – sprzedający nie może zmienić waluty
    counterparty: consignor.name,
    consignor_id: consignor.id,
    amount: contractTotal(items),
    payment_days: company.payment_days ?? 7,
    items,
    seller_email: consignor.email,
    seller_phone: consignor.phone,
    sign_token: token,
    sign_expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
    notes: "Umowa wypełniona przez komisanta w panelu komisanta.",
  }).select("id").single();
  if (error || !c) return { error: `Nie udało się przygotować umowy: ${errorMessage(error)}` };
  const kept = await bindUnits(db, c.id, r.units, { via: "umowa z panelu" });
  if (!kept.length) {
    await db.from("contracts").delete().eq("id", c.id);
    return { error: "Zaznaczone rzeczy mają już umowę albo fakturę." };
  }
  revalidatePath("/komis");
  redirect(`/podpis/${token}`);
}

/** Adres do wgrania faktury komisanta prosto do plików umów (PDF / JPG / PNG, do 10 MB). */
export async function prepareInvoiceUpload(fileName: string, size: number): Promise<{ path: string; token: string; sig: string } | { error: string }> {
  const { db, consignor } = await requireConsignor();
  const ext = (fileName.split(".").pop() ?? "").toLowerCase().replace("jpeg", "jpg");
  if (!["pdf", "jpg", "png"].includes(ext)) return { error: "Faktura musi być plikiem PDF, JPG albo PNG." };
  if (!(size > 0) || size > 10 * 1024 * 1024) return { error: "Plik może mieć najwyżej 10 MB." };
  const now = new Date();
  const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await db.storage.from("contracts").createSignedUploadUrl(path);
  if (error || !data) return { error: `Nie można przygotować wgrania pliku: ${error?.message ?? "błąd"}` };
  return { path, token: data.token, sig: signUploadPath(path, `consignor:${consignor.id}`) };
}

/** Faktura komisanta do sprzedanych rzeczy (zamiast umowy). */
export async function attachConsignorInvoice(_: DocState, fd: FormData): Promise<DocState> {
  const { db, consignor } = await requireConsignor();
  let file: { path: string; name: string } | null;
  try {
    file = uploadedFile(fd, `consignor:${consignor.id}`);
  } catch {
    file = null;
  }
  if (!file || !/\.(pdf|jpg|png)$/.test(file.path)) return { error: "Dołącz plik faktury (PDF, JPG albo PNG)." };
  const docNumber = String(fd.get("doc_number") ?? "").trim().slice(0, 60);
  if (!docNumber) return { error: "Wpisz numer faktury." };
  const docDate = String(fd.get("doc_date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate)) return { error: "Podaj datę wystawienia faktury." };
  const { count: used } = await db.from("contracts").select("id", { count: "exact", head: true }).eq("file_path", file.path);
  if (used) return { error: "Ten plik jest już użyty – dołącz fakturę ponownie." };
  const { data: blob, error: dErr } = await db.storage.from("contracts").download(file.path);
  if (dErr || !blob) return { error: "Nie znalazłem wgranego pliku – dołącz fakturę ponownie." };
  const buf = Buffer.from(await blob.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024 || !labelFileType(buf)) {
    await db.storage.from("contracts").remove([file.path]);
    return { error: "Faktura musi być prawdziwym plikiem PDF, JPG albo PNG (do 10 MB)." };
  }
  const r = await soldWithoutContract(db, consignor, fd);
  if ("error" in r) return { error: r.error };
  const items = itemsOf(r.units);
  const { data: c, error } = await db.from("contracts").insert({
    type: "invoice",
    source: "consignor_invoice",
    status: "signed", // czeka na zatwierdzenie przez sklep (Umowy)
    counterparty: consignor.name,
    consignor_id: consignor.id,
    contract_date: docDate,
    doc_number: docNumber,
    amount: contractTotal(items),
    currency: "PLN",
    items,
    file_path: file.path,
    file_name: file.name,
    notes: "Faktura wgrana przez komisanta w panelu komisanta.",
  }).select("id").single();
  if (error || !c) return { error: `Nie udało się zapisać faktury: ${errorMessage(error)}` };
  const kept = await bindUnits(db, c.id, r.units, { via: "faktura z panelu", doc_number: docNumber });
  if (!kept.length) {
    await db.from("contracts").delete().eq("id", c.id);
    return { error: "Zaznaczone rzeczy mają już umowę albo fakturę." };
  }
  const name = escapeHtml(consignor.name);
  await tellCompany(db, `Komis: ${consignor.name} dołączył fakturę ${docNumber}`,
    `<p>Komisant <b>${name}</b> wgrał fakturę <b>${escapeHtml(docNumber)}</b> do sprzedanych rzeczy: ${kept.map((u) => u.code).join(", ")}.</p><p>Sprawdź i zatwierdź ją w aplikacji: Umowy → Do zatwierdzenia.</p>`);
  revalidatePath("/komis");
  return { ok: `Faktura ${docNumber} wysłana do sprawdzenia (${kept.length} szt.). Damy znać, gdy ją zatwierdzimy.${r.skipped ? ` ${r.skipped} zaznaczonych rzeczy miało już umowę.` : ""}` };
}
