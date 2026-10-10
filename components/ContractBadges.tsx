import Link from "next/link";
import { money } from "@/lib/labels";
import { STAGE_TEXT, type ContractLite, type ContractStage } from "@/lib/contracts/stage";

/** Umowa jest (zielony). Nieopłacona umowa z linku – mały dopisek. */
export function ContractDone({ c, stage, label }: { c: Pick<ContractLite, "id">; stage: ContractStage; label?: string }) {
  return (
    <Link className="inline-flex flex-col whitespace-nowrap rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100" href={`/umowy/${c.id}`}>
      {label ?? "umowa ✓"}
      {stage === "pay" && <span className="font-normal text-emerald-700">nieopłacona</span>}
    </Link>
  );
}

/** „Umowa w toku” (pomarańczowy) z etapem i podglądem umowy po najechaniu. */
export function ContractInProgress({ c, stage }: { c: ContractLite; stage: ContractStage }) {
  return (
    <span className="group/umowa relative inline-block">
      <Link className="inline-flex flex-col whitespace-nowrap rounded border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-800 hover:bg-orange-100" href={`/umowy/${c.id}`}>
        Umowa w toku
        <span className="font-normal">{STAGE_TEXT[stage]}</span>
      </Link>
      <span role="tooltip" className="pointer-events-none invisible absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-line bg-white p-2.5 text-left text-xs font-normal text-ink opacity-0 shadow-xl transition-opacity group-hover/umowa:visible group-hover/umowa:opacity-100">
        <b className="block text-sm">{c.type === "invoice" ? "Faktura" : "Umowa"} {c.doc_number ?? (c.number ? `nr ${c.number}` : "")}</b>
        <span className="block">{c.counterparty && c.counterparty !== "(czeka na podpis)" ? c.counterparty : "sprzedający jeszcze nie podpisał"}</span>
        {c.amount !== null && c.amount !== undefined && <span className="block tabular-nums">Kwota: {money(c.amount)}</span>}
        <span className="block text-muted">Etap: {STAGE_TEXT[stage]}{c.source === "consignor" || c.source === "consignor_invoice" ? " · od komisanta" : ""}</span>
        <span className="mt-1 block text-accent">Kliknij, aby otworzyć</span>
      </span>
    </span>
  );
}

/** Rzecz komisanta bez umowy (czerwony). */
export function ConsignorWaiting() {
  return <span className="inline-block max-w-44 rounded border border-bad/30 bg-rose-50 px-2 py-0.5 text-xs font-medium text-bad">czeka na umowę od komisanta</span>;
}
