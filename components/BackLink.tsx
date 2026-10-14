"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

/** Licznik przejść w aplikacji (ustawia menu) – „Wróć” cofa tylko wtedy, gdy jest dokąd w aplikacji. */
let inApp = 0;
export function markNavigation() {
  inApp++;
}

/** „← Wróć”: poprzednia strona w aplikacji (np. lista z wyszukiwaniem), a po wejściu z zewnątrz – strona `href`. */
export function BackLink({ href, label = "Wróć" }: { href: string; label?: string }) {
  const router = useRouter();
  return (
    <Link
      href={href}
      className="mb-2 inline-flex items-center gap-1 rounded-md py-1 pr-2 text-sm font-medium text-accent hover:underline"
      onClick={(e) => {
        if (inApp > 1) {
          e.preventDefault();
          router.back();
        }
      }}
    >
      <span aria-hidden>←</span> {label}
    </Link>
  );
}
