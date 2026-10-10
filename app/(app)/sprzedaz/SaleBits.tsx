import Link from "next/link";
import { Pill } from "@/components/ui";
import { ORDER_STATUS, ORDER_STATUS_TONE, type OrderStatus } from "@/lib/orders/status";

export type SaleUnit = {
  id: string; code: string; identifier: string | null; owner_type: string; status: string;
  consignor: { name: string } | null;
  contract: { id: string; counterparty: string; status: string; template: string | null } | null;
} | null;

export type PendingContract = { id: string; status: string } | undefined;

/** Kolumna „Umowa” linii sprzedaży: stan umowy albo przycisk wygenerowania / dodania. */
export function SaleContract({ saleId, status, hasVariant, unit, pending }: { saleId: string; status: string; hasVariant: boolean; unit: SaleUnit; pending: PendingContract }) {
  return (
    <>
      {unit?.contract ? (
        <Link className="text-accent hover:underline" href={`/umowy/${unit.contract.id}`}>
          {unit.contract.status === "sent" ? "czeka na podpis" : unit.contract.status === "signed" && unit.contract.template ? "do zatwierdzenia" : unit.contract.counterparty}
        </Link>
      ) : pending ? (
        <Link className="text-accent hover:underline" href={`/umowy/${pending.id}`}>
          {pending.status === "sent" ? "czeka na podpis" : pending.status === "signed" ? "do zatwierdzenia" : pending.status === "rejected" ? "odrzucona" : "zatwierdzona"}
        </Link>
      ) : status === "no_unit" && hasVariant ? (
        <Link className="btn-secondary px-2.5 py-1 text-xs" href={`/umowy/z-szablonu?sprzedaz=${saleId}`}>Dołącz umowę</Link>
      ) : unit ? (
        <Link className="btn-secondary px-2.5 py-1 text-xs" href={`/umowy/z-szablonu?ids=${unit.id}`}>Dodaj umowę</Link>
      ) : null}
      {unit?.status === "in_transit" && <span className="block text-xs text-warn">towar w drodze</span>}
    </>
  );
}

export function UnitCell({ unit }: { unit: SaleUnit }) {
  if (!unit) return <span className="text-muted">–</span>;
  return (
    <span className="font-mono text-xs">
      <Link className="text-accent hover:underline" href={`/magazyn/${unit.id}`}>{unit.code}</Link>
      {unit.identifier && <span className="block text-muted">{unit.identifier}</span>}
      {unit.owner_type === "consignment" && <span className="block"><Pill tone="blue">komis · {unit.consignor?.name}</Pill></span>}
    </span>
  );
}

export const SALE_SELECT =
  "id, order_id, order_ref, product_name, status, sold_at, variant_id, store:stores(name), unit:units(id, code, identifier, owner_type, status, consignor:consignors(name), contract:contracts(id, counterparty, status, template)), variant:variants(option, product:products(title))";

/** Status zamówienia; „Problem” jako wyraźna czerwona plakietka. */
export function OrderStatusPill({ status }: { status: OrderStatus }) {
  if (status === "problem") {
    return <span className="inline-flex items-center whitespace-nowrap rounded bg-bad px-1.5 py-0.5 text-xs font-semibold text-white">{ORDER_STATUS.problem}</span>;
  }
  return <Pill tone={ORDER_STATUS_TONE[status]}>{ORDER_STATUS[status]}</Pill>;
}
