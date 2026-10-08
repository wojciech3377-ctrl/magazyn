export const UNIT_STATUS: Record<string, string> = {
  in_transit: "w drodze",
  in_stock: "na stanie",
  reserved: "zarezerwowana",
  sold: "sprzedana",
  shipped: "wydana",
  returned: "zwrot",
};

export const UNIT_STATUS_TONE: Record<string, string> = {
  in_transit: "bg-amber-50 text-amber-800 ring-amber-200",
  in_stock: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  reserved: "bg-sky-50 text-sky-800 ring-sky-200",
  sold: "bg-slate-100 text-slate-700 ring-slate-200",
  shipped: "bg-slate-100 text-slate-700 ring-slate-200",
  returned: "bg-rose-50 text-rose-800 ring-rose-200",
};

export const PURCHASE_FORM: Record<string, string> = {
  vat_margin: "VAT marża",
  invoice: "FV",
  receipt_0: "paragon 0%",
  consignment: "komis",
};

export const OWNER_TYPE: Record<string, string> = {
  own: "własna",
  consignment: "komis",
};

export const CONTRACT_TYPE: Record<string, string> = {
  purchase: "umowa kupna",
  consignment: "umowa komisowa",
  invoice: "FV zakupu",
  other: "inna",
};

export const SALE_STATUS: Record<string, string> = {
  assigned: "przypisana",
  no_unit: "brak sztuki na stanie",
  unmatched: "produkt bez powiązania",
  cancelled: "anulowana / zwrot",
};

export const EVENT_TYPE: Record<string, string> = {
  received: "przyjęcie",
  moved: "przesunięcie",
  status: "zmiana statusu",
  sold: "sprzedaż",
  swapped: "zamieniona przy pakowaniu",
  returned: "zwrot",
  contract: "umowa",
  edited: "edycja",
};

export function money(v: number | string | null | undefined) {
  if (v === null || v === undefined || v === "") return "–";
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(Number(v));
}

export function dateTime(v: string | null | undefined) {
  if (!v) return "–";
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(new Date(v));
}

export function dateOnly(v: string | null | undefined) {
  if (!v) return "–";
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeZone: "Europe/Warsaw" }).format(new Date(v));
}
