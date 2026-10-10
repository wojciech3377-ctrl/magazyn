"use server";

import { revalidatePath } from "next/cache";
import { requireConsignor, consignmentFee, defaultAddress, labelFileType, type ShipAddress } from "@/lib/consignment";
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
          `<p>Komisant <b>${consignor.name.replace(/</g, "&lt;")}</b> zlecił wysyłkę: ${reserved.map((u) => u.code).join(", ")}.</p><p>Sposób: ${method === "default" ? "adres z konta" : method === "custom" ? `inny adres (opłata ${fee} zł – wystaw fakturę)` : "własna etykieta (w załączniku zlecenia)"}.</p><p>Obsłuż w aplikacji: Komisanci → ${consignor.name.replace(/</g, "&lt;")}.</p>`);
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
