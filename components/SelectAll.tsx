"use client";

/** Zaznacza / odznacza wszystkie pola „ids” w formularzu, w którym stoi. */
export function SelectAll() {
  return (
    <input
      type="checkbox"
      className="h-4 w-4"
      aria-label="Zaznacz wszystkie na tej stronie"
      title="Zaznacz wszystkie na tej stronie"
      onChange={(e) => {
        const form = e.currentTarget.form;
        form?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="ids"]').forEach((c) => (c.checked = e.currentTarget.checked));
      }}
    />
  );
}
