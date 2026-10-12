"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { BarcodeScanner } from "@/components/BarcodeScanner";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  /** Własna obsługa zeskanowanego kodu. Bez niej: kod trafia do pola i formularz (GET) się wysyła. */
  onScan?: (code: string) => void;
  /** Skaner zostaje otwarty i czyta kolejne kody (np. inwentaryzacja). */
  continuous?: boolean;
  /** Większe pole (Kasa, inwentaryzacja). */
  large?: boolean;
  /** Bez lupy po lewej (pole kodu). */
  noIcon?: boolean;
  wrapperClassName?: string;
};

/**
 * Pole wyszukiwania z wbudowanym przyciskiem aparatu (po prawej, w środku pola): klik → skaner kodów.
 * Działa jako zwykły input – w formularzach GET albo sterowany przez value/onChange.
 */
export const SearchInput = forwardRef<HTMLInputElement, Props>(function SearchInput(
  { onScan, continuous, large, noIcon, wrapperClassName = "", className = "", ...input },
  ref,
) {
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current!);
  const [scanning, setScanning] = useState(false);
  const [skip, setSkip] = useState<string | undefined>();
  const lastScanned = useRef<string | undefined>(undefined);
  const before = useRef<{ value: string; scanned: boolean }>({ value: "", scanned: false });

  /** Wpisuje wartość do pola tak, jak gdyby wpisała ją osoba (działa też w polach sterowanych przez React). */
  function setValue(value: string) {
    const el = inner.current;
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Aparat: pole czyści się, a poprzedni kod jest pomijany – od razu można skanować kolejny przedmiot. */
  function openScanner() {
    const prev = inner.current?.value.trim() || lastScanned.current;
    before.current = { value: inner.current?.value ?? "", scanned: false };
    setSkip(prev || undefined);
    if (inner.current?.value) setValue("");
    setScanning(true);
  }

  /** Zamknięcie bez odczytu – w polu wraca to, co było wpisane. */
  function close() {
    setScanning(false);
    if (!before.current.scanned && before.current.value && !inner.current?.value) setValue(before.current.value);
  }

  function handle(code: string) {
    lastScanned.current = code;
    before.current.scanned = true;
    if (!continuous) setScanning(false);
    if (onScan) return onScan(code);
    // Pole niesterowane: wpisz kod i wyślij formularz (np. Magazyn → wyniki dla kodu).
    setValue(code);
    inner.current?.form?.requestSubmit();
  }

  return (
    <div className={`relative min-w-0 ${wrapperClassName}`}>
      {!noIcon && <Icon name="search" className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 ${large ? "h-5 w-5" : "h-4 w-4"}`} />}
      <input
        ref={inner}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        {...input}
        className={`input ${noIcon ? "" : large ? "pl-10" : "pl-9"} ${large ? "h-12 pr-14 text-lg" : "pr-11"} [&::-webkit-search-cancel-button]:hidden ${className}`}
      />
      <button
        type="button"
        onClick={openScanner}
        className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-accent-soft hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${large ? "h-10 w-11" : "h-8 w-9"}`}
        aria-label="Skanuj kod aparatem"
        title="Skanuj kod aparatem"
      >
        <Icon name="camera" className={large ? "h-6 w-6" : "h-5 w-5"} />
      </button>
      {scanning && <BarcodeScanner continuous={continuous} skip={skip} onResult={handle} onClose={close} />}
    </div>
  );
});
