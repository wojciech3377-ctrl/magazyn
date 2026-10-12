import type { MetadataRoute } from "next";

/** Aplikacja na telefon (iPhone: Safari → Udostępnij → „Do ekranu początkowego”): pełny ekran bez paska przeglądarki. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Magazyn – Telefoniki i Sneakers Depot",
    short_name: "Magazyn",
    description: "Magazyn, Kasa i sprzedaż – Telefoniki i Sneakers Depot",
    id: "/",
    start_url: "/",
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
  };
}
