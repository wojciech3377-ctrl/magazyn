"use client";

import { useFormStatus } from "react-dom";

/** Przycisk wysyłający formularz po potwierdzeniu (np. usuwanie). */
export function ConfirmSubmit({ message, children, className = "btn-danger", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { message: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      {...rest}
      className={className}
      disabled={pending || rest.disabled}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {pending ? "Usuwam…" : children}
    </button>
  );
}
