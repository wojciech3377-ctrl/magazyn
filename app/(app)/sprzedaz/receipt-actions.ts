"use server";

import { revalidatePath } from "next/cache";
import { requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueOrderReceipt, enqueuePosReceipt, orderReceiptLines, posReceiptLines } from "@/lib/fiscal/jobs";
import { errorMessage } from "@/lib/errors";

export type JobView = { id: string; status: string; receipt_number: string | null; error: string | null; claimed_at: string | null; number: number };
const UUID = /^[0-9a-f-]{36}$/i;

/** Stan paragonu w kolejce (odświeżany na ekranie, dopóki drukarka nie skończy). */
export async function receiptJobStatus(id: string): Promise<JobView | null> {
  const { supabase } = await requireSection("sprzedaz", "kasa");
  if (!UUID.test(id)) return null;
  const { data } = await supabase.from("receipt_jobs").select("id, status, receipt_number, error, claimed_at, number").eq("id", id).maybeSingle();
  return (data as JobView | null) ?? null;
}

/** Paragon do sprzedaży w Kasie albo do zamówienia ze sklepu – do kolejki drukarki fiskalnej. */
export async function enqueueReceipt(kind: "pos" | "order", id: string): Promise<{ job?: JobView; error?: string }> {
  const { profile } = await requireSection("sprzedaz", "kasa");
  if (!UUID.test(id)) return { error: "Zła sprzedaż." };
  const db = createAdminClient();
  try {
    const j = kind === "pos" ? await enqueuePosReceipt(db, id, profile.id) : await enqueueOrderReceipt(db, id, profile.id);
    revalidatePath(kind === "pos" ? `/kasa/${id}` : `/sprzedaz/${id}`);
    return { job: { id: j.id, status: j.status, receipt_number: null, error: null, claimed_at: null, number: j.number } };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/**
 * Ponów wydruk po błędzie. Paragon „drukuje się” dłużej niż 2 minuty (program przestał odpowiadać) też można ponowić –
 * wcześniej sprawdź na drukarce, czy paragon nie wyszedł, żeby nie wydrukować go dwa razy.
 */
export async function retryReceiptJob(id: string): Promise<{ job?: JobView; error?: string }> {
  await requireSection("sprzedaz", "kasa");
  if (!UUID.test(id)) return { error: "Złe zadanie." };
  const db = createAdminClient();
  const stuck = new Date(Date.now() - 120_000).toISOString();
  // Po błędzie – pozycje od nowa z bieżących danych i ustawień (np. zmieniona stawka PTU w Wykluczeniach).
  const { data: job } = await db.from("receipt_jobs").select("status, source, order_id, pos_order_id").eq("id", id).maybeSingle();
  let fresh: { lines: unknown; payment: string } | null = null;
  if (job?.status === "error") {
    try {
      fresh = job.source === "order" && job.order_id ? await orderReceiptLines(db, job.order_id as string)
        : job.source === "pos" && job.pos_order_id ? await posReceiptLines(db, job.pos_order_id as string) : null;
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }
  const { data, error } = await db.from("receipt_jobs").update({ status: "queued", error: null, printer_id: null, claimed_at: null, ...(fresh ? { lines: fresh.lines, payment: fresh.payment } : {}) })
    .eq("id", id).or(`status.eq.error,and(status.eq.printing,claimed_at.lt.${stuck})`).select("id, status, receipt_number, error, claimed_at, number").maybeSingle();
  if (error) return { error: errorMessage(error) };
  if (!data) return { error: "Tego paragonu nie można teraz ponowić." };
  return { job: data as JobView };
}

/** Anulowanie paragonu, który jeszcze się nie wydrukował (np. błąd i sprzedaż idzie na fakturę). */
export async function cancelReceiptJob(id: string): Promise<{ job?: JobView; error?: string }> {
  await requireSection("sprzedaz", "kasa");
  if (!UUID.test(id)) return { error: "Złe zadanie." };
  const db = createAdminClient();
  const { data } = await db.from("receipt_jobs").update({ status: "cancelled" }).eq("id", id).in("status", ["queued", "error"])
    .select("id, status, receipt_number, error, claimed_at, number").maybeSingle();
  if (!data) return { error: "Paragon już się drukuje albo jest wydrukowany – nie można go anulować." };
  return { job: data as JobView };
}
