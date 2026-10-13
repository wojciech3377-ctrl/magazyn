/** Kod metki produktu: PR + numer produktu (np. PR000123) – inny niż kody sztuk (S000123). Bez zależności serwerowych. */
export const productTagCode = (no: number | string) => `PR${String(no).padStart(6, "0")}`;
export const parseProductTagCode = (code: string) => {
  const m = code.trim().toUpperCase().match(/^PR0*(\d{1,12})$/);
  return m ? Number(m[1]) : null;
};
