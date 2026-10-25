/** Aplikacja na telefon dla komisanta: otwiera od razu panel komisanta (osobna ikona niż aplikacja pracownika). */
export const dynamic = "force-static";

export function GET() {
  return Response.json({
    name: "Panel komisanta",
    short_name: "Mój komis",
    description: "Twoje rzeczy w komisie, sprzedaże, umowy i rozliczenia",
    id: "/komis",
    start_url: "/komis",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f8fafc",
    theme_color: "#ffffff",
    lang: "pl",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
}
