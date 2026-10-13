"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Przejście pod adres zaraz po wyświetleniu (np. podgląd PDF po zakończeniu sprzedaży). */
export function AutoOpen({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    // Zamiana adresu bez ?pdf=1, żeby „Wróć” nie otwierało PDF ponownie.
    window.history.replaceState(null, "", window.location.pathname);
    router.push(href);
  }, [href, router]);
  return null;
}
