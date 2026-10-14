import Link from "next/link";
import { UNIT_STATUS, UNIT_STATUS_TONE } from "@/lib/labels";
import { BackLink } from "@/components/BackLink";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${UNIT_STATUS_TONE[status] ?? "bg-slate-100 ring-slate-200"}`}>
      {UNIT_STATUS[status] ?? status}
    </span>
  );
}

export function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "red" | "amber" | "green" | "blue" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700 ring-slate-200/70",
    red: "bg-red-50 text-red-700 ring-red-200/70",
    amber: "bg-amber-50 text-amber-800 ring-amber-200/70",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-200/70",
    blue: "bg-blue-50 text-blue-700 ring-blue-200/70",
  };
  const dots = { slate: "bg-slate-400", red: "bg-red-500", amber: "bg-amber-500", green: "bg-emerald-500", blue: "bg-blue-500" };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dots[tone]}`} aria-hidden="true" />{children}
    </span>
  );
}

export function PageHeader({ title, sub, actions, back }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode; back?: string }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0">
        {back && <BackLink href={back} />}
        <h1 className="h1">{title}</h1>
        {sub && <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted sm:mt-1.5 sm:text-sm">{sub}</p>}
      </div>
      {/* Telefon: przyciski w jednym przewijanym rzędzie zamiast kilku linii. */}
      {actions && <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 xl:justify-end [&>*]:shrink-0">{actions}</div>}
    </div>
  );
}

export function Thumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`${src}${src.includes("?") ? "&" : "?"}width=96`} alt={alt} className="h-10 w-10 shrink-0 rounded-lg border border-line bg-white object-contain" loading="lazy" />
  ) : (
    <div className="h-10 w-10 shrink-0 rounded-lg border border-line bg-slate-50" />
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
  const nums = [...new Set([1, cur - 1, cur, cur + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const btn = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-line bg-white px-2.5 text-sm text-ink shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50";
  const off = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-line bg-slate-50 px-2.5 text-sm text-muted opacity-50";
  return (
    <nav aria-label="Strony" className={`${top ? "mb-3" : "mt-4"} flex flex-wrap items-center justify-between gap-2 text-sm text-muted`}>
      <span>Strona {cur} z {pages} · {total} pozycji</span>
      <div className="flex flex-wrap items-center gap-1">
        {cur > 1 ? <Link className={btn} href={href(1)} aria-label="Pierwsza strona">«</Link> : <span className={off}>«</span>}
        {cur > 1 ? <Link className={btn} href={href(cur - 1)}>‹<span className="hidden sm:inline">&nbsp;Poprzednia</span></Link> : <span className={off}>‹<span className="hidden sm:inline">&nbsp;Poprzednia</span></span>}
        {nums.map((n, i) => (
          <span key={n} className="flex items-center gap-1">
            {i > 0 && n - nums[i - 1] > 1 && <span className="px-1">…</span>}
            {n === cur ? <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg bg-ink px-2.5 text-sm font-medium text-white shadow-sm" aria-current="page">{n}</span> : <Link className={btn} href={href(n)}>{n}</Link>}
          </span>
        ))}
        {cur < pages ? <Link className={btn} href={href(cur + 1)}><span className="hidden sm:inline">Następna&nbsp;</span>›</Link> : <span className={off}><span className="hidden sm:inline">Następna&nbsp;</span>›</span>}
        {cur < pages ? <Link className={btn} href={href(pages)} aria-label="Ostatnia strona">»</Link> : <span className={off}>»</span>}
        <form method="get" className="ml-2 hidden items-center gap-1 sm:flex">
          {entries.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <label className="text-xs" htmlFor={`strona-${top ? "g" : "d"}`}>Idź do</label>
          <input id={`strona-${top ? "g" : "d"}`} className="input h-8 w-16 px-2 py-1" type="number" name="strona" min={1} max={pages} defaultValue={cur} />
          <button className="btn-secondary h-8 px-2.5 py-1">OK</button>
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
  const tones = { info: "border-blue-200/80 bg-blue-50/70 text-blue-950", error: "border-red-200/80 bg-red-50/80 text-red-900", ok: "border-emerald-200/80 bg-emerald-50/80 text-emerald-900" };
  const icons = { info: "i", error: "!", ok: "✓" };
  const dot = { info: "bg-blue-600", error: "bg-red-600", ok: "bg-emerald-600" };
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed ${tones[tone]}`} role={tone === "error" ? "alert" : "status"}>
      <span className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${dot[tone]}`} aria-hidden="true">{icons[tone]}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
