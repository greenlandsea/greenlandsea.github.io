export type RGB = { r: number; g: number; b: number };

export async function loadImageData(url: string): Promise<ImageData> {
  const img = new Image();
  // Needed if images are ever served from a different origin; harmless for same-origin.
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D not available");
  ctx.drawImage(img, 0, 0);
  try {
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read pixels from image (${url}): ${msg}`);
  }
}

// Very fast 256-color quantization (RGB332). Good enough for “texture-like” draping.
export function rgbToIndex332(r: number, g: number, b: number) {
  const r3 = r >> 5; // 0..7
  const g3 = g >> 5; // 0..7
  const b2 = b >> 6; // 0..3
  return (r3 << 5) | (g3 << 2) | b2; // 0..255
}

export function index332ToRgb(idx: number): RGB {
  const r3 = (idx >> 5) & 0b111;
  const g3 = (idx >> 2) & 0b111;
  const b2 = idx & 0b11;
  return {
    r: Math.round((r3 * 255) / 7),
    g: Math.round((g3 * 255) / 7),
    b: Math.round((b2 * 255) / 3),
  };
}

export function makeDiscreteColorscale332(): Array<[number, string]> {
  const stops: Array<[number, string]> = [];
  for (let i = 0; i < 256; i++) {
    const { r, g, b } = index332ToRgb(i);
    const color = `rgb(${r},${g},${b})`;
    // Keep this small (256 entries) so Plotly doesn't choke on an oversized colorscale.
    stops.push([i / 255, color]);
  }
  return stops;
}

export function getPixelRGBA(img: ImageData, x: number, y: number) {
  const ix = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const o = (iy * img.width + ix) * 4;
  const d = img.data;
  return { r: d[o], g: d[o + 1], b: d[o + 2], a: d[o + 3] };
}
