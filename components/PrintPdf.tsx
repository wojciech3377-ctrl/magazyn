"use client";

/**
 * Wydruk PDF od razu w systemowym oknie drukowania: PDF ładuje się w ukrytej ramce, a po załadowaniu
 * wywoływane jest print(). Gdy przeglądarka tego nie pozwala – PDF otwiera się w nowej karcie.
 */
export function printPdf(url: string) {
  document.getElementById("print-pdf-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "print-pdf-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  frame.src = url;
  frame.onload = () => {
    // Przeglądarkowy podgląd PDF potrzebuje chwili po załadowaniu.
    setTimeout(() => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        window.open(url, "_blank");
      }
    }, 400);
  };
  document.body.appendChild(frame);
}

export function PrintPdfButton({ url, className = "btn", children }: { url: string; className?: string; children: React.ReactNode }) {
  return <button type="button" className={className} onClick={() => printPdf(url)}>{children}</button>;
}
