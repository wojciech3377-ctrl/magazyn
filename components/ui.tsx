import Link from "next/link";
import { UNIT_STATUS, UNIT_STATUS_TONE } from "@/lib/labels";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${UNIT_STATUS_TONE[status] ?? "bg-slate-100 ring-slate-200"}`}>
      {UNIT_STATUS[status] ?? status}
    </span>
  );
}

export function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "red" | "amber" | "green" | "blue" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
    red: "bg-rose-50 text-rose-800 ring-rose-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    blue: "bg-sky-50 text-sky-800 ring-sky-200",
  };
  return <span className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>{children}</span>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="h1">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Thumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`${src}${src.includes("?") ? "&" : "?"}width=96`} alt={alt} className="h-10 w-10 shrink-0 rounded border border-line bg-white object-contain" loading="lazy" />
  ) : (
    <div className="h-10 w-10 shrink-0 rounded border border-line bg-panel" />
  );
}

export function Pagination({ page, total, perPage, params }: { page: number; total: number; perPage: number; params: Record<string, string | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const href = (p: number) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    q.set("strona", String(p));
    return `?${q.toString()}`;
  };
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-muted">
      <span>Strona {page} z {pages}</span>
      <div className="flex gap-2">
        {page > 1 && <Link className="btn-secondary" href={href(page - 1)}>Poprzednia</Link>}
        {page < pages && <Link className="btn-secondary" href={href(page + 1)}>Następna</Link>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "ok"; children: React.ReactNode }) {
  const tones = { info: "border-sky-200 bg-sky-50 text-sky-900", error: "border-rose-200 bg-rose-50 text-rose-900", ok: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <div className={`rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>{children}</div>;
}
