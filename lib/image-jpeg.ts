/**
 * Zmniejszenie zdjęcia w przeglądarce do JPEG (dłuższy bok maks. `max` px, białe tło zamiast przezroczystości).
 * Działa też ze zdjęciami z iPhone'a (HEIC) – Safari je odczytuje i obraca zgodnie z EXIF.
 */
export async function toJpeg(file: Blob, max = 1600, quality = 0.85): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error("Nie można odczytać tego zdjęcia – wybierz JPG albo PNG.");
    }
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Przeglądarka nie może przygotować zdjęcia.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let q = quality;
    for (;;) {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
      if (!blob) throw new Error("Przeglądarka nie może przygotować zdjęcia.");
      if (blob.size <= 1_700_000 || q <= 0.5) return blob;
      q -= 0.1;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Zamienia pole „photo” w formularzu na zmniejszony JPEG (puste pole – usuwa je). */
export async function withJpegPhoto(fd: FormData, field = "photo") {
  const f = fd.get(field);
  fd.delete(field);
  if (f instanceof File && f.size) fd.set(field, new File([await toJpeg(f)], "zdjecie.jpg", { type: "image/jpeg" }));
  return fd;
}
