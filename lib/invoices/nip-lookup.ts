import "server-only";

/**
 * Dane firmy po NIP: GUS (BIR 1.1, gdy w Vercel jest GUS_BIR_KEY) albo Biała lista VAT Ministerstwa Finansów
 * (bez klucza, tylko podatnicy VAT). Zwraca nazwę i adres do faktury.
 */

export type CompanyData = { name: string; address1: string; address2: string; country: "PL"; source: "GUS" | "MF"; vatStatus?: string | null };

const GUS_URL = process.env.GUS_BIR_URL || "https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc";
const NS = "http://CIS/BIR/PUBL/2014/07";

function soap(action: string, body: string) {
  return `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ns="${NS}" xmlns:dat="${NS}/DataContract">` +
    `<soap:Header xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:To>${GUS_URL}</wsa:To><wsa:Action>${NS}/IUslugaBIRzewnPubl/${action}</wsa:Action></soap:Header>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`;
}

async function gusCall(action: string, body: string, sid?: string) {
  const res = await fetch(GUS_URL, {
    method: "POST",
    headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${NS}/IUslugaBIRzewnPubl/${action}"`, ...(sid ? { sid } : {}) },
    body: soap(action, body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GUS: błąd ${res.status}`);
  return text;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? "";

function title(s: string) {
  // GUS i MF podają nazwy wielkimi literami – adres ładniej z wielkiej litery, nazwa firmy bez zmian.
  return s.toLowerCase().replace(/(^|[\s\-/.])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

async function fromGus(nip: string, key: string): Promise<CompanyData | null> {
  const login = await gusCall("Zaloguj", `<ns:Zaloguj><ns:pKluczUzytkownika>${key}</ns:pKluczUzytkownika></ns:Zaloguj>`);
  const sid = tag(login, "ZalogujResult");
  if (!sid) throw new Error("GUS: nie udało się zalogować (sprawdź GUS_BIR_KEY)");
  try {
    const res = await gusCall("DaneSzukajPodmioty",
      `<ns:DaneSzukajPodmioty><ns:pParametryWyszukiwania><dat:Nip>${nip}</dat:Nip></ns:pParametryWyszukiwania></ns:DaneSzukajPodmioty>`, sid);
    const inner = decode(tag(res, "DaneSzukajPodmiotyResult"));
    const dane = tag(inner, "dane");
    if (!dane || tag(dane, "ErrorCode")) return null;
    const street = tag(dane, "Ulica") || tag(dane, "Miejscowosc");
    const nr = [tag(dane, "NrNieruchomosci"), tag(dane, "NrLokalu")].filter(Boolean).join("/");
    const city = tag(dane, "MiejscowoscPoczty") || tag(dane, "Miejscowosc");
    return {
      name: tag(dane, "Nazwa"),
      address1: [street.replace(/^ul\.\s*/i, "ul. "), nr].filter(Boolean).join(" "),
      address2: [tag(dane, "KodPocztowy"), city].filter(Boolean).join(" "),
      country: "PL",
      source: "GUS",
    };
  } finally {
    await gusCall("Wyloguj", `<ns:Wyloguj><ns:pIdentyfikatorSesji>${sid}</ns:pIdentyfikatorSesji></ns:Wyloguj>`).catch(() => null);
  }
}

async function fromWhiteList(nip: string): Promise<CompanyData | null> {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  const res = await fetch(`https://wl-api.mf.gov.pl/api/search/nip/${nip}?date=${day}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Biała lista VAT: błąd ${res.status}`);
  const body = (await res.json()) as { result?: { subject?: { name?: string; workingAddress?: string | null; residenceAddress?: string | null; statusVat?: string } | null } };
  const s = body.result?.subject;
  if (!s?.name) return null;
  const addr = (s.workingAddress || s.residenceAddress || "").trim();
  const i = addr.lastIndexOf(",");
  return {
    name: s.name,
    address1: title(i > 0 ? addr.slice(0, i) : addr),
    address2: i > 0 ? title(addr.slice(i + 1).trim()) : "",
    country: "PL",
    source: "MF",
    vatStatus: s.statusVat ?? null,
  };
}

export async function lookupNip(nip: string): Promise<CompanyData | null> {
  const key = process.env.GUS_BIR_KEY;
  if (key) {
    try {
      const g = await fromGus(nip, key);
      if (g) return g;
    } catch {
      // GUS niedostępny – próbujemy białą listę
    }
  }
  return fromWhiteList(nip);
}
