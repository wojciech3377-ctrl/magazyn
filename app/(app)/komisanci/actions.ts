"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";

export async function saveConsignor(formData: FormData) {
  const { supabase } = await requireProfile();
  const id = String(formData.get("id") ?? "");
  const row = {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim() || null,
    phone: String(formData.get("phone") ?? "").trim() || null,
    bank_account: String(formData.get("bank_account") ?? "").replace(/\s/g, "") || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
  };
  if (!row.name) return;
  if (id) await supabase.from("consignors").update(row).eq("id", id);
  else await supabase.from("consignors").insert(row);
  revalidatePath("/komisanci");
}
