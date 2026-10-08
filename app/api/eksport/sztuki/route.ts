import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { queryUnits } from "@/lib/queries/units";
import { OWNER_TYPE, PURCHASE_FORM, UNIT_STATUS } from "@/lib/labels";

export const dynamic = "force-dynamic";

function csv(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Eksport listy sztuk (te same filtry co ekran Magazyn), CSV z separatorem „;” dla Excela. */
export async function GET(req: NextRequest) {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return new Response("unauthorized", { status: 401 });
  const { data: profile } = await db.from("profiles").select("can_see_prices").eq("id", auth.user.id).single();
  const p = Object.fromEntries(req.nextUrl.searchParams);
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { rows: batch } = await queryUnits(db, p, [from, from + 999]);
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  const header = ["kod", "produkt", "sku_modelu", "rozmiar", "imei_nr", "sklep", "lokalizacja", "regal", "status", "wlasciciel", "komisant", "forma_sprzedazy",
    ...(profile?.can_see_prices ? ["cena_zakupu", "wyplata_komis"] : []), "umowa", "przyjeta", "sprzedana"];
  const lines = rows.map((u) => [
    u.code, u.variant.product.title, u.variant.product.style_sku, u.variant.option, u.identifier, u.location.store.name, u.location.name, u.shelf,
    UNIT_STATUS[u.status], OWNER_TYPE[u.owner_type], u.consignor?.name, PURCHASE_FORM[u.purchase_form],
    ...(profile?.can_see_prices ? [u.purchase_price?.toString().replace(".", ","), u.payout_amount?.toString().replace(".", ",")] : []),
    u.contract ? u.contract.counterparty : "BRAK", u.received_at?.slice(0, 10), u.sold_at?.slice(0, 10),
  ].map(csv).join(";"));
  const body = "﻿" + [header.join(";"), ...lines].join("\r\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sztuki-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
