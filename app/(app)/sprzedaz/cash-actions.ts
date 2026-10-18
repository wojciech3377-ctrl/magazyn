"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";

const BACK = "/sprzedaz?widok=stacjonarna";
const go = (key: "ok" | "blad", m: string): never => redirect(`${BACK}&${key}=${encodeURIComponent(m)}`);
const pln = (n: number) => `${n.toFixed(2).replace(".", ",")} zł`;
const SQL66 = "Gotówka w kasie wymaga SQL 66 w Supabase (SQL Editor).";

/** Gotówka w kasie: wyzerowanie (zabieram wszystko), wypłata (zabieram kwotę) albo wpłata (np. drobne na start). */
export async function cashMovement(fd: FormData) {
  const { supabase, profile } = await requireAdmin();
  const storeId = String(fd.get("store_id") ?? "");
  const kind = String(fd.get("kind") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(storeId) || !["withdraw", "deposit", "reset"].includes(kind)) go("blad", "Nieznana operacja.");
  const note = String(fd.get("note") ?? "").trim().slice(0, 200) || null;
  const { data: rows, error: bErr } = await supabase.rpc("cash_balances");
  if (bErr) go("blad", /cash_balances|schema cache/i.test(bErr.message) ? SQL66 : bErr.message);
  const balance = Number(((rows ?? []) as { store_id: string; balance: number }[]).find((r) => r.store_id === storeId)?.balance ?? 0);
  let amount: number;
  if (kind === "reset") {
    amount = Math.max(0, Math.round(balance * 100) / 100);
    if (amount <= 0) go("blad", "W kasie nie ma gotówki do zabrania.");
  } else {
    amount = Math.round(Number(String(fd.get("amount") ?? "").replace(/\s/g, "").replace(",", ".")) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) go("blad", "Wpisz kwotę większą od zera.");
    if (kind === "withdraw" && amount > balance + 0.004) go("blad", `W kasie jest ${pln(balance)} – nie można zabrać ${pln(amount)}. Jeśli w kasie jest więcej, zapisz najpierw wpłatę.`);
  }
  const { error } = await supabase.from("cash_movements").insert({ store_id: storeId, kind, amount, balance_before: balance, note, created_by: profile.id });
  if (error) go("blad", /cash_movements|schema cache/i.test(error.message) ? SQL66 : error.message);
  revalidatePath("/sprzedaz");
  go("ok", kind === "reset" ? `Kasa wyzerowana – zabrano ${pln(amount)}.` : kind === "withdraw" ? `Zapisano: zabrano ${pln(amount)}. W kasie zostaje ${pln(balance - amount)}.` : `Zapisano wpłatę ${pln(amount)}. W kasie jest ${pln(balance + amount)}.`);
}

/** Cofnięcie ostatniej (pomyłkowej) operacji na gotówce. */
export async function undoCashMovement(fd: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(fd.get("id") ?? "");
  const { error } = await supabase.from("cash_movements").delete().eq("id", id);
  if (error) go("blad", error.message);
  revalidatePath("/sprzedaz");
  go("ok", "Operacja na gotówce usunięta.");
}
