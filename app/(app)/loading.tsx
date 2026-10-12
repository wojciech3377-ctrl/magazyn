/** Szkielet strony na czas ładowania danych – menu zostaje, treść pojawia się od razu po odczycie. */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Ładowanie">
      <div className="mb-2 h-7 w-56 rounded-lg bg-slate-200/80" />
      <div className="mb-6 h-4 w-96 max-w-full rounded bg-slate-200/60" />
      <div className="card space-y-3 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-slate-200/70" />
            <div className="h-4 flex-1 rounded bg-slate-200/60" />
            <div className="h-4 w-24 rounded bg-slate-200/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
