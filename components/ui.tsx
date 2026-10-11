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

/** Stronicowanie: pierwsza / poprzednia / numery stron / następna / ostatnia i skok do wybranej strony. Na górze i na dole listy. */
export function Pagination({ page, total, perPage, params, top }: { page: number; total: number; perPage: number; params: Record<string, string | undefined>; top?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const cur = Math.min(Math.max(1, page), pages);
  const entries = Object.entries(params).filter(([k, v]) => v && k !== "strona") as [string, string][];
  const href = (p: number) => {
    const q = new URLSearchParams(entries);
    q.set("strona", String(p));
    return `?${q.toString()}`;
  };
  const nums = [...new Set([1, cur - 2, cur - 1, cur, cur + 1, cur + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const btn = "inline-flex min-w-9 items-center justify-center rounded-md border border-line bg-white px-2.5 py-1.5 text-sm text-ink hover:border-accent hover:bg-sky-50";
  const off = "inline-flex min-w-9 items-center justify-center rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-muted opacity-50";
  return (
    <nav aria-label="Strony" className={`${top ? "mb-3" : "mt-4"} flex flex-wrap items-center justify-between gap-2 text-sm text-muted`}>
      <span>Strona {cur} z {pages} · {total} pozycji</span>
      <div className="flex flex-wrap items-center gap-1">
        {cur > 1 ? <Link className={btn} href={href(1)} aria-label="Pierwsza strona">«</Link> : <span className={off}>«</span>}
        {cur > 1 ? <Link className={btn} href={href(cur - 1)}>‹ Poprzednia</Link> : <span className={off}>‹ Poprzednia</span>}
        {nums.map((n, i) => (
          <span key={n} className="flex items-center gap-1">
            {i > 0 && n - nums[i - 1] > 1 && <span className="px-1">…</span>}
            {n === cur ? <span className="inline-flex min-w-9 items-center justify-center rounded-md bg-ink px-2.5 py-1.5 text-sm font-medium text-white" aria-current="page">{n}</span> : <Link className={btn} href={href(n)}>{n}</Link>}
          </span>
        ))}
        {cur < pages ? <Link className={btn} href={href(cur + 1)}>Następna ›</Link> : <span className={off}>Następna ›</span>}
        {cur < pages ? <Link className={btn} href={href(pages)} aria-label="Ostatnia strona">»</Link> : <span className={off}>»</span>}
        <form method="get" className="ml-2 flex items-center gap-1">
          {entries.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <label className="text-xs" htmlFor={`strona-${top ? "g" : "d"}`}>Idź do</label>
          <input id={`strona-${top ? "g" : "d"}`} className="input w-16 px-2 py-1" type="number" name="strona" min={1} max={pages} defaultValue={cur} />
          <button className="btn-secondary px-2.5 py-1.5">OK</button>
        </form>
      </div>
    </nav>
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
