import { readFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { requireAdmin } from "@/lib/auth";
import { appUrl } from "@/lib/app-url";

export const dynamic = "force-dynamic";

const FILES = ["DrukarkaMagazyn.ps1", "Instaluj.ps1", "Zainstaluj.bat", "Odinstaluj.bat", "CZYTAJ-MNIE.txt"];
/** Biblioteka drukarek ELZAB (freeware, ELZAB S.A.): ElzabDR.dll z bibliotekami pomocniczymi MinGW. */
const ELZAB = [
  "elzab/ElzabDR-licencja.pdf",
  ...["ElzabDR.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"].map((f) => `elzab/x64/${f}`),
  ...["ElzabDR.dll", "libgcc_s_dw2-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"].map((f) => `elzab/x86/${f}`),
];
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

/** Program „Drukarka Magazyn” dla Windows (ZIP) z adresem tej aplikacji. Klucz drukarki wpisuje się przy instalacji. */
export async function GET() {
  await requireAdmin();
  const dir = path.join(process.cwd(), "agent/drukarka");
  const out: Record<string, Uint8Array> = {};
  for (const f of FILES) {
    const buf = new Uint8Array(await readFile(path.join(dir, f)));
    // PowerShell 5.1 czyta pliki bez BOM jako ANSI – polskie znaki tylko z BOM UTF-8.
    out[`DrukarkaMagazyn/${f}`] = /\.(ps1|txt)$/.test(f) ? new Uint8Array([...BOM, ...buf]) : buf;
  }
  for (const f of ELZAB) out[`DrukarkaMagazyn/${f}`] = new Uint8Array(await readFile(path.join(dir, f)));
  out["DrukarkaMagazyn/adres.txt"] = new Uint8Array([...BOM, ...strToU8(await appUrl())]);
  const zip = zipSync(out, { level: 6 });
  return new Response(Buffer.from(zip), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="DrukarkaMagazyn.zip"', "Cache-Control": "no-store" },
  });
}
