export type RGB = { r: number; g: number; b: number };

function clampByte(x: number) {
  return Math.max(0, Math.min(255, Math.round(x)));
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "").trim();
  if (h.length !== 6) throw new Error(`Expected 6-digit hex color, got: ${hex}`);
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function makeLinearPalette(hexStops: string[], n: number): RGB[] {
  if (n <= 0) return [];
  if (hexStops.length < 2) throw new Error("Need at least 2 stops");
  if (n === 1) return [hexToRgb(hexStops[0])];

  const stops = hexStops.map(hexToRgb);
  const out: RGB[] = [];
  const segments = stops.length - 1;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const s = t * segments;
    const seg = Math.min(segments - 1, Math.floor(s));
    const local = s - seg;
    const a = stops[seg];
    const b = stops[seg + 1];
    out.push({
      r: clampByte(lerp(a.r, b.r, local)),
      g: clampByte(lerp(a.g, b.g, local)),
      b: clampByte(lerp(a.b, b.b, local)),
    });
  }
  return out;
}

export function paletteToColorscale(palette: RGB[]): Array<[number, string]> {
  if (!palette.length) return [];
  const denom = Math.max(1, palette.length - 1);
  return palette.map((c, i) => [i / denom, `rgb(${c.r},${c.g},${c.b})`]);
}

export function rdylbu_r_256(): RGB[] {
  // ColorBrewer RdYlBu reversed (blue -> red), similar to matplotlib's RdYlBu_r.
  const stops = [
    "#313695",
    "#4575b4",
    "#74add1",
    "#abd9e9",
    "#e0f3f8",
    "#ffffbf",
    "#fee090",
    "#fdae61",
    "#f46d43",
    "#d73027",
    "#a50026",
  ];
  return makeLinearPalette(stops, 256);
}

export function rgbKey(r: number, g: number, b: number) {
  return (r << 16) | (g << 8) | b;
}

