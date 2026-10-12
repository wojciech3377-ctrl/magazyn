"use client";

import Link from "next/link";
import { useActionState } from "react";
import { addOrderToWtb, addToWtb, type WtbAddState } from "@/app/(app)/wtb/actions";

/** „Dodaj do WTB”: pozycja zamówienia (orderId + line) albo linia sprzedaży (saleId) trafia na listę WTB. */
export function WtbButton({ orderId, line, saleId, compact }: { orderId?: string; line?: number; saleId?: string; compact?: boolean }) {
  const [state, action, pending] = useActionState<WtbAddState, FormData>(addToWtb, null);
  if (state?.ok) {
    return <Link href="/wtb" className="relative z-10 whitespace-nowrap text-xs text-ok hover:underline">✓ {compact ? "w WTB" : state.ok}</Link>;
  }
  return (
    <form action={action} className="relative z-10 inline-flex items-center gap-1.5">
      {orderId && <input type="hidden" name="order_id" value={orderId} />}
      {line !== undefined && <input type="hidden" name="line" value={line} />}
      {saleId && <input type="hidden" name="sale_id" value={saleId} />}
      <button
        className={compact ? "whitespace-nowrap text-xs text-accent hover:underline disabled:opacity-50" : "btn-secondary whitespace-nowrap px-2.5 py-1 text-xs"}
        disabled={pending}
        title="Dodaj do listy WTB (want to buy)"
      >
        {pending ? "…" : compact ? "+ WTB" : "Dodaj do WTB"}
      </button>
      {state?.error && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}

/** „Dodaj do WTB” pod „Drukuj paragon”: wszystkie produkty zamówienia od razu na listę WTB. */
export function WtbOrderButton({ orderId, inWtb }: { orderId: string; inWtb?: boolean }) {
  const [state, action, pending] = useActionState<WtbAddState, FormData>(addOrderToWtb, null);
  if (inWtb || state?.ok) return <Link href="/wtb" className="relative z-10 whitespace-nowrap text-xs text-ok hover:underline" title={state?.ok}>✓ w WTB</Link>;
  return (
    <form action={action} className="relative z-10 inline-flex flex-col items-start gap-1">
      <input type="hidden" name="order_id" value={orderId} />
      <button className="btn-secondary whitespace-nowrap px-2.5 py-1 text-xs" disabled={pending} title="Dodaj produkty z tego zamówienia do listy WTB">{pending ? "Dodaję…" : "Dodaj do WTB"}</button>
      {state?.error && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
