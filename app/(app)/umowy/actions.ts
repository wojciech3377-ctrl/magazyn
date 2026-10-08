"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { parseAmount, uploadedFile } from "@/lib/contracts/upload";

function codes(text: string) {
  return text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "")).filter(Boolean);
}

async function attachByCodes(supabase: Awaited<ReturnType<typeof requireProfile>>["supabase"], contractId: string, text: string) {
  const list = codes(text);
  if (!list.length) return { attached: 0, missing: [] as string[] };
  const { data: units } = await supabase.from("units").select("id, code, identifier").or(
    `code.in.(${list.join(",")}),identifier.in.(${list.join(",")})`,
  );
  const found = units ?? [];
  if (found.length) {
    await supabase.from("units").update({ contract_id: contractId }).in("id", found.map((u) => u.id));
    await supabase.from("unit_events").insert(found.map((u) => ({ unit_id: u.id, type: "contract", data: { contract_id: contractId } })));
  }
  const hit = new Set(found.flatMap((u) => [u.code, (u.identifier ?? "").toUpperCase()]));
  return { attached: found.length, missing: list.filter((c) => !hit.has(c)) };
}

export async function createContract(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase } = await requireProfile();
  let id: string;
  let note = "";
  try {
    const counterparty = String(formData.get("counterparty") ?? "").trim();
    if (!counterparty) return { error: "Podaj, z kim jest umowa." };
    const type = String(formData.get("type") ?? "purchase");
    const file = uploadedFile(formData);
    const { data, error } = await supabase.from("contracts").insert({
      type,
      counterparty,
      consignor_id: type === "consignment" ? String(formData.get("consignor_id") ?? "") || null : null,
      contract_date: String(formData.get("contract_date") ?? "") || null,
      amount: parseAmount(formData.get("amount")),
      notes: String(formData.get("notes") ?? "").trim() || null,
      file_path: file?.path ?? null,
      file_name: file?.name ?? null,
    }).select("id").single();
    if (error) throw error;
    id = data.id;
    const r = await attachByCodes(supabase, id, String(formData.get("units") ?? ""));
    if (r.missing.length) note = `?blad=${encodeURIComponent(`Nie znaleziono sztuk: ${r.missing.join(", ")}`)}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String((e as { message?: string }).message ?? e) };
  }
  revalidatePath("/umowy");
  redirect(`/umowy/${id}${note}`);
}

export async function attachUnits(formData: FormData) {
  const { supabase } = await requireProfile();
  const id = String(formData.get("id"));
  const r = await attachByCodes(supabase, id, String(formData.get("units") ?? ""));
  revalidatePath(`/umowy/${id}`);
  const msg = r.missing.length ? `blad=${encodeURIComponent(`Przypięto ${r.attached}. Nie znaleziono: ${r.missing.join(", ")}`)}` : `ok=${encodeURIComponent(`Przypięto ${r.attached} szt.`)}`;
  redirect(`/umowy/${id}?${msg}`);
}

export async function detachUnit(formData: FormData) {
  const { supabase } = await requireProfile();
  const id = String(formData.get("id"));
  const unitId = String(formData.get("unit_id"));
  await supabase.from("units").update({ contract_id: null }).eq("id", unitId).eq("contract_id", id);
  await supabase.from("unit_events").insert({ unit_id: unitId, type: "contract", data: { contract_id: null, detached_from: id } });
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}`);
}

export async function replaceFile(formData: FormData) {
  const { supabase } = await requireProfile();
  const id = String(formData.get("id"));
  let msg = "ok=" + encodeURIComponent("Plik zapisany.");
  try {
    const file = uploadedFile(formData);
    if (!file) msg = "blad=" + encodeURIComponent("Wybierz plik.");
    else await supabase.from("contracts").update({ file_path: file.path, file_name: file.name }).eq("id", id);
  } catch (e) {
    msg = "blad=" + encodeURIComponent(e instanceof Error ? e.message : String(e));
  }
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}?${msg}`);
}

export async function deleteContract(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id"));
  const { data: c } = await supabase.from("contracts").select("file_path").eq("id", id).single();
  await supabase.from("units").update({ contract_id: null }).eq("contract_id", id);
  const { error } = await supabase.from("contracts").delete().eq("id", id);
  if (error) redirect(`/umowy/${id}?blad=${encodeURIComponent(error.message)}`);
  if (c?.file_path) await supabase.storage.from("contracts").remove([c.file_path]);
  revalidatePath("/umowy");
  redirect("/umowy");
}
