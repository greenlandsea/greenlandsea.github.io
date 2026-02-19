type BathyGrid = {
  lon: number[];
  lat: number[];
  z: number[][];
};

function linspace(a: number, b: number, n: number) {
  const out: number[] = [];
  if (n <= 1) return [a];
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out.push(a + i * step);
  return out;
}

// A small synthetic bathymetry surface so the 3D map works out-of-the-box.
// Replace by dropping `public/data/bathy.json` (see README).
export function makeSyntheticGreenlandSeaBathy(): BathyGrid {
  const lon = linspace(-25, 20, 120);
  const lat = linspace(62, 82, 110);

  const z: number[][] = [];
  for (let j = 0; j < lat.length; j++) {
    const row: number[] = [];
    for (let i = 0; i < lon.length; i++) {
      const x = (lon[i] + 2) / 15;
      const y = (lat[j] - 73) / 7.5;
      const basin = -2200 - 900 * Math.exp(-0.9 * (x * x + y * y));
      const ridge = -600 * Math.exp(-0.7 * ((x + 0.9) * (x + 0.9) + (y + 0.2) * (y + 0.2)));
      const slope = 150 * (y - 0.5);
      row.push(basin + ridge + slope);
    }
    z.push(row);
  }
  return { lon, lat, z };
}

