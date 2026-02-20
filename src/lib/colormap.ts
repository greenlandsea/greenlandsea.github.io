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

export function blues_r_256(): RGB[] {
  // A reasonable "Blues_r"-like palette (dark -> light).
  const stops = ["#08306b", "#08519c", "#2171b5", "#4292c6", "#6baed6", "#9ecae1", "#c6dbef", "#deebf7"];
  return makeLinearPalette(stops, 256);
}

export function topo_256(): RGB[] {
  // Approximation of cmocean.topo: deep blue -> shallow -> greens -> browns -> white.
  const stops = [
    "#0b1f3a",
    "#123c6b",
    "#1f6fb2",
    "#52b7d6",
    "#a7e3e1",
    "#e6f2c5",
    "#8fd18b",
    "#4aa35a",
    "#8d7b4f",
    "#b08b5a",
    "#d7c28f",
    "#ffffff",
  ];
  return makeLinearPalette(stops, 256);
}

export function ice_256(): RGB[] {
  // cmocean.ice sampled at 256 steps (precomputed).
  return [
    { r: 4, g: 6, b: 19 },
    { r: 5, g: 6, b: 20 },
    { r: 5, g: 7, b: 21 },
    { r: 6, g: 8, b: 23 },
    { r: 7, g: 9, b: 24 },
    { r: 8, g: 10, b: 26 },
    { r: 9, g: 11, b: 27 },
    { r: 10, g: 12, b: 29 },
    { r: 11, g: 13, b: 30 },
    { r: 12, g: 13, b: 31 },
    { r: 13, g: 14, b: 33 },
    { r: 14, g: 15, b: 34 },
    { r: 15, g: 16, b: 36 },
    { r: 16, g: 17, b: 37 },
    { r: 17, g: 18, b: 39 },
    { r: 18, g: 19, b: 40 },
    { r: 19, g: 19, b: 42 },
    { r: 20, g: 20, b: 43 },
    { r: 21, g: 21, b: 44 },
    { r: 22, g: 22, b: 46 },
    { r: 23, g: 23, b: 47 },
    { r: 23, g: 24, b: 49 },
    { r: 24, g: 24, b: 50 },
    { r: 25, g: 25, b: 52 },
    { r: 26, g: 26, b: 53 },
    { r: 27, g: 27, b: 55 },
    { r: 28, g: 28, b: 56 },
    { r: 29, g: 28, b: 58 },
    { r: 30, g: 29, b: 59 },
    { r: 31, g: 30, b: 61 },
    { r: 31, g: 31, b: 62 },
    { r: 32, g: 31, b: 64 },
    { r: 33, g: 32, b: 65 },
    { r: 34, g: 33, b: 67 },
    { r: 35, g: 34, b: 68 },
    { r: 36, g: 34, b: 70 },
    { r: 37, g: 35, b: 71 },
    { r: 37, g: 36, b: 73 },
    { r: 38, g: 37, b: 74 },
    { r: 39, g: 37, b: 76 },
    { r: 40, g: 38, b: 78 },
    { r: 41, g: 39, b: 79 },
    { r: 41, g: 40, b: 81 },
    { r: 42, g: 40, b: 82 },
    { r: 43, g: 41, b: 84 },
    { r: 44, g: 42, b: 85 },
    { r: 44, g: 43, b: 87 },
    { r: 45, g: 43, b: 89 },
    { r: 46, g: 44, b: 90 },
    { r: 47, g: 45, b: 92 },
    { r: 47, g: 46, b: 94 },
    { r: 48, g: 47, b: 95 },
    { r: 49, g: 47, b: 97 },
    { r: 49, g: 48, b: 98 },
    { r: 50, g: 49, b: 100 },
    { r: 51, g: 50, b: 102 },
    { r: 51, g: 50, b: 103 },
    { r: 52, g: 51, b: 105 },
    { r: 53, g: 52, b: 107 },
    { r: 53, g: 53, b: 108 },
    { r: 54, g: 53, b: 110 },
    { r: 54, g: 54, b: 112 },
    { r: 55, g: 55, b: 113 },
    { r: 56, g: 56, b: 115 },
    { r: 56, g: 57, b: 117 },
    { r: 57, g: 57, b: 118 },
    { r: 57, g: 58, b: 120 },
    { r: 58, g: 59, b: 122 },
    { r: 58, g: 60, b: 123 },
    { r: 58, g: 61, b: 125 },
    { r: 59, g: 62, b: 127 },
    { r: 59, g: 62, b: 128 },
    { r: 60, g: 63, b: 130 },
    { r: 60, g: 64, b: 132 },
    { r: 60, g: 65, b: 133 },
    { r: 61, g: 66, b: 135 },
    { r: 61, g: 67, b: 137 },
    { r: 61, g: 68, b: 138 },
    { r: 62, g: 69, b: 140 },
    { r: 62, g: 70, b: 141 },
    { r: 62, g: 71, b: 143 },
    { r: 62, g: 72, b: 144 },
    { r: 62, g: 73, b: 146 },
    { r: 62, g: 73, b: 147 },
    { r: 63, g: 74, b: 149 },
    { r: 63, g: 75, b: 150 },
    { r: 63, g: 76, b: 151 },
    { r: 63, g: 78, b: 153 },
    { r: 63, g: 79, b: 154 },
    { r: 63, g: 80, b: 155 },
    { r: 63, g: 81, b: 157 },
    { r: 63, g: 82, b: 158 },
    { r: 63, g: 83, b: 159 },
    { r: 63, g: 84, b: 160 },
    { r: 63, g: 85, b: 161 },
    { r: 63, g: 86, b: 162 },
    { r: 63, g: 87, b: 163 },
    { r: 63, g: 88, b: 164 },
    { r: 63, g: 89, b: 165 },
    { r: 62, g: 90, b: 166 },
    { r: 62, g: 92, b: 167 },
    { r: 62, g: 93, b: 168 },
    { r: 62, g: 94, b: 169 },
    { r: 62, g: 95, b: 170 },
    { r: 62, g: 96, b: 171 },
    { r: 62, g: 97, b: 171 },
    { r: 62, g: 98, b: 172 },
    { r: 62, g: 99, b: 173 },
    { r: 62, g: 101, b: 173 },
    { r: 62, g: 102, b: 174 },
    { r: 62, g: 103, b: 175 },
    { r: 62, g: 104, b: 175 },
    { r: 62, g: 105, b: 176 },
    { r: 62, g: 106, b: 176 },
    { r: 63, g: 107, b: 177 },
    { r: 63, g: 108, b: 178 },
    { r: 63, g: 110, b: 178 },
    { r: 63, g: 111, b: 179 },
    { r: 63, g: 112, b: 179 },
    { r: 63, g: 113, b: 180 },
    { r: 64, g: 114, b: 180 },
    { r: 64, g: 115, b: 180 },
    { r: 64, g: 116, b: 181 },
    { r: 64, g: 117, b: 181 },
    { r: 65, g: 118, b: 182 },
    { r: 65, g: 120, b: 182 },
    { r: 66, g: 121, b: 183 },
    { r: 66, g: 122, b: 183 },
    { r: 66, g: 123, b: 183 },
    { r: 67, g: 124, b: 184 },
    { r: 67, g: 125, b: 184 },
    { r: 68, g: 126, b: 185 },
    { r: 68, g: 127, b: 185 },
    { r: 69, g: 128, b: 185 },
    { r: 69, g: 129, b: 186 },
    { r: 70, g: 130, b: 186 },
    { r: 70, g: 132, b: 187 },
    { r: 71, g: 133, b: 187 },
    { r: 71, g: 134, b: 187 },
    { r: 72, g: 135, b: 188 },
    { r: 73, g: 136, b: 188 },
    { r: 73, g: 137, b: 188 },
    { r: 74, g: 138, b: 189 },
    { r: 75, g: 139, b: 189 },
    { r: 75, g: 140, b: 189 },
    { r: 76, g: 141, b: 190 },
    { r: 77, g: 142, b: 190 },
    { r: 78, g: 143, b: 191 },
    { r: 78, g: 144, b: 191 },
    { r: 79, g: 145, b: 191 },
    { r: 80, g: 146, b: 192 },
    { r: 81, g: 148, b: 192 },
    { r: 81, g: 149, b: 192 },
    { r: 82, g: 150, b: 193 },
    { r: 83, g: 151, b: 193 },
    { r: 84, g: 152, b: 194 },
    { r: 85, g: 153, b: 194 },
    { r: 85, g: 154, b: 194 },
    { r: 86, g: 155, b: 195 },
    { r: 87, g: 156, b: 195 },
    { r: 88, g: 157, b: 195 },
    { r: 89, g: 158, b: 196 },
    { r: 90, g: 159, b: 196 },
    { r: 91, g: 160, b: 197 },
    { r: 92, g: 161, b: 197 },
    { r: 93, g: 162, b: 197 },
    { r: 94, g: 163, b: 198 },
    { r: 95, g: 164, b: 198 },
    { r: 95, g: 166, b: 199 },
    { r: 96, g: 167, b: 199 },
    { r: 97, g: 168, b: 199 },
    { r: 98, g: 169, b: 200 },
    { r: 99, g: 170, b: 200 },
    { r: 100, g: 171, b: 201 },
    { r: 101, g: 172, b: 201 },
    { r: 103, g: 173, b: 201 },
    { r: 104, g: 174, b: 202 },
    { r: 105, g: 175, b: 202 },
    { r: 106, g: 176, b: 203 },
    { r: 107, g: 177, b: 203 },
    { r: 108, g: 178, b: 203 },
    { r: 109, g: 179, b: 204 },
    { r: 110, g: 180, b: 204 },
    { r: 111, g: 181, b: 205 },
    { r: 113, g: 182, b: 205 },
    { r: 114, g: 184, b: 206 },
    { r: 115, g: 185, b: 206 },
    { r: 116, g: 186, b: 206 },
    { r: 117, g: 187, b: 207 },
    { r: 119, g: 188, b: 207 },
    { r: 120, g: 189, b: 208 },
    { r: 121, g: 190, b: 208 },
    { r: 123, g: 191, b: 208 },
    { r: 124, g: 192, b: 209 },
    { r: 125, g: 193, b: 209 },
    { r: 127, g: 194, b: 210 },
    { r: 128, g: 195, b: 210 },
    { r: 130, g: 196, b: 211 },
    { r: 131, g: 197, b: 211 },
    { r: 133, g: 198, b: 211 },
    { r: 134, g: 199, b: 212 },
    { r: 136, g: 200, b: 212 },
    { r: 137, g: 201, b: 213 },
    { r: 139, g: 202, b: 213 },
    { r: 140, g: 203, b: 214 },
    { r: 142, g: 204, b: 214 },
    { r: 144, g: 205, b: 215 },
    { r: 146, g: 206, b: 215 },
    { r: 147, g: 207, b: 216 },
    { r: 149, g: 208, b: 216 },
    { r: 151, g: 209, b: 217 },
    { r: 153, g: 210, b: 217 },
    { r: 154, g: 211, b: 218 },
    { r: 156, g: 212, b: 218 },
    { r: 158, g: 213, b: 219 },
    { r: 160, g: 214, b: 220 },
    { r: 162, g: 214, b: 220 },
    { r: 164, g: 215, b: 221 },
    { r: 166, g: 216, b: 222 },
    { r: 168, g: 217, b: 222 },
    { r: 169, g: 218, b: 223 },
    { r: 171, g: 219, b: 224 },
    { r: 173, g: 220, b: 224 },
    { r: 175, g: 221, b: 225 },
    { r: 177, g: 222, b: 226 },
    { r: 179, g: 223, b: 227 },
    { r: 181, g: 224, b: 227 },
    { r: 183, g: 225, b: 228 },
    { r: 185, g: 226, b: 229 },
    { r: 186, g: 227, b: 230 },
    { r: 188, g: 228, b: 231 },
    { r: 190, g: 229, b: 231 },
    { r: 192, g: 230, b: 232 },
    { r: 194, g: 230, b: 233 },
    { r: 196, g: 231, b: 234 },
    { r: 198, g: 232, b: 235 },
    { r: 200, g: 233, b: 236 },
    { r: 201, g: 234, b: 237 },
    { r: 203, g: 235, b: 238 },
    { r: 205, g: 236, b: 239 },
    { r: 207, g: 237, b: 239 },
    { r: 209, g: 238, b: 240 },
    { r: 211, g: 239, b: 241 },
    { r: 213, g: 240, b: 242 },
    { r: 214, g: 241, b: 243 },
    { r: 216, g: 242, b: 244 },
    { r: 218, g: 243, b: 245 },
    { r: 220, g: 244, b: 246 },
    { r: 222, g: 245, b: 247 },
    { r: 224, g: 246, b: 248 },
    { r: 225, g: 247, b: 249 },
    { r: 227, g: 249, b: 250 },
    { r: 229, g: 250, b: 251 },
    { r: 231, g: 251, b: 251 },
    { r: 232, g: 252, b: 252 },
    { r: 234, g: 253, b: 253 },
  ];
}

export function rgbKey(r: number, g: number, b: number) {
  return (r << 16) | (g << 8) | b;
}
