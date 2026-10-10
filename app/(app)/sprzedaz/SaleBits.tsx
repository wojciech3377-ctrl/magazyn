import Link from "next/link";
import { Pill } from "@/components/ui";
import { ORDER_STATUS, ORDER_STATUS_TONE, type OrderStatus } from "@/lib/orders/status";
import { contractStage, STAGE_TEXT, type ContractLite, type ContractStage } from "@/lib/contracts/stage";
import { money } from "@/lib/labels";

export type SaleUnit = {
  id: string; code: string; identifier: string | null; owner_type: string; status: string;
  consignor: { name: string } | null;
  contract: ContractLite | null;
} | null;

export type PendingContract = ContractLite | undefined;

/** „Umowa w toku” z etapem i podglądem umowy po najechaniu. */
export function ContractInProgress({ c, stage }: { c: ContractLite; stage: ContractStage }) {
  return (
    <span className="group/umowa relative inline-block">
      <Link className="inline-flex flex-col whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100" href={`/umowy/${c.id}`}>
        Umowa w toku
        <span className="font-normal">{STAGE_TEXT[stage]}</span>
      </Link>
      <span role="tooltip" className="pointer-events-none invisible absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-line bg-white p-2.5 text-left text-xs font-normal text-ink opacity-0 shadow-xl transition-opacity group-hover/umowa:visible group-hover/umowa:opacity-100">
        <b className="block text-sm">Umowa {c.doc_number ?? (c.number ? `nr ${c.number}` : "")}</b>
        <span className="block">{c.counterparty && c.counterparty !== "(czeka na podpis)" ? c.counterparty : "sprzedający jeszcze nie podpisał"}</span>
        {c.amount !== null && c.amount !== undefined && <span className="block tabular-nums">Kwota: {money(c.amount)}</span>}
        <span className="block text-muted">Etap: {STAGE_TEXT[stage]}{c.source === "consignor" ? " · od komisanta" : ""}</span>
        <span className="mt-1 block text-accent">Kliknij, aby otworzyć umowę</span>
      </span>
    </span>
  );
}

/** Kolumna „Umowa” linii sprzedaży: stan umowy albo przycisk dołączenia. */
export function SaleContract({ saleId, status, unit, pending }: { saleId: string; status: string; hasVariant?: boolean; unit: SaleUnit; pending: PendingContract }) {
  const c = unit?.contract ?? pending ?? null;
  const stage = c ? contractStage(c) : null;
  return (
    <>
      {c && stage === "done" ? (
        <Link className="text-accent hover:underline" href={`/umowy/${c.id}`}>{c.counterparty ?? "umowa"} ✓</Link>
      ) : c && stage && stage !== "dead" ? (
        <ContractInProgress c={c} stage={stage} />
      ) : unit?.owner_type === "consignment" ? (
        <span className="text-xs font-medium text-warn">czeka na umowę od komisanta</span>
      ) : status !== "cancelled" && status !== "unmatched" ? (
        <Link className="btn-secondary px-2.5 py-1 text-xs" href={`/sprzedaz/umowa?sprzedaz=${saleId}`}>Dołącz umowę</Link>
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
  "id, order_id, order_ref, product_name, status, sold_at, variant_id, shopify_line_id, shopify_line_index, store:stores(name), unit:units(id, code, identifier, owner_type, status, consignor:consignors(name), contract:contracts(id, counterparty, status, template, paid_at, source, number, doc_number, amount, type)), variant:variants(option, product:products(title))";

/** Status zamówienia; „Problem” jako wyraźna czerwona plakietka. */
export function OrderStatusPill({ status }: { status: OrderStatus }) {
  if (status === "problem") {
    return <span className="inline-flex items-center whitespace-nowrap rounded bg-bad px-1.5 py-0.5 text-xs font-semibold text-white">{ORDER_STATUS.problem}</span>;
  }
  return <Pill tone={ORDER_STATUS_TONE[status]}>{ORDER_STATUS[status]}</Pill>;
}
