import * as zarr from "zarrita";
import { withBase } from "./paths";

export type GsZarrVariable = {
  id: "T" | "S";
  label: string;
  units?: string;
  available: boolean;
};

export type GsZarrMeta = {
  storeUrl: string;
  lon: number[];
  lat: number[];
  z: number[]; // meters (typically negative down)
  timeIso: string[]; // YYYY-MM-DD
  variables: GsZarrVariable[];
};

type ZMetadata = {
  metadata: Record<string, any>;
  zarr_consolidated_format?: number;
};

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function toAbsoluteUrl(urlOrPath: string) {
  if (typeof window === "undefined") return urlOrPath;
  return new URL(urlOrPath, window.location.href).toString();
}

function configuredStoreUrl() {
  try {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search).get("store");
      if (p && p.trim()) return p.trim();
    }
  } catch {
    // ignore
  }

  const envUrl = (import.meta as any)?.env?.VITE_GS_ZARR_URL;
  if (typeof envUrl === "string" && envUrl.trim()) return envUrl.trim();

  return withBase("data/GS.zarr");
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText} for ${url}`);
  }
  return (await r.json()) as T;
}

function parseTimeUnits(units: string): { baseMs: number; unit: "seconds" | "days" } | null {
  // Examples:
  // - "seconds since 1993-08-01"
  // - "seconds since 1993-08-01 00:00:00"
  const m = units.match(/^\s*(seconds|days)\s+since\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/i);
  if (!m) return null;
  const unit = m[1].toLowerCase() as "seconds" | "days";
  const ymd = m[2];
  const hh = Number(m[3] ?? "0");
  const mm = Number(m[4] ?? "0");
  const ss = Number(m[5] ?? "0");
  const [y, mon, d] = ymd.split("-").map((x) => Number(x));
  const baseMs = Date.UTC(y, mon - 1, d, hh, mm, ss);
  return { baseMs, unit };
}

function toIsoDates(values: ArrayLike<number>, units: string) {
  const parsed = parseTimeUnits(units);
  if (!parsed) {
    return Array.from({ length: values.length }, (_, i) => `t=${i}`);
  }
  const unitMs = parsed.unit === "days" ? 24 * 60 * 60 * 1000 : 1000;
  const out: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const ms = parsed.baseMs + Number(values[i]) * unitMs;
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function ensureNegativeDown(z: number[]) {
  const finite = z.filter((v) => Number.isFinite(v));
  if (!finite.length) return z;
  const allPositive = finite.every((v) => v >= 0);
  if (!allPositive) return z;
  return z.map((v) => (Number.isFinite(v) ? -Math.abs(v) : v));
}

function reshape2D(data: ArrayLike<number>, nRows: number, nCols: number): number[][] {
  const out: number[][] = new Array(nRows);
  let k = 0;
  for (let j = 0; j < nRows; j++) {
    const row = new Array(nCols);
    for (let i = 0; i < nCols; i++) row[i] = Number(data[k++]);
    out[j] = row;
  }
  return out;
}

type BathyGrid = { lon: number[]; lat: number[] };

async function loadBathyLonLat(): Promise<BathyGrid> {
  const j = await fetchJson<any>(withBase("data/bathy.json"));
  if (!Array.isArray(j?.lon) || !Array.isArray(j?.lat)) {
    throw new Error("public/data/bathy.json missing lon/lat arrays");
  }
  return { lon: j.lon.map(Number), lat: j.lat.map(Number) };
}

const arrayPromiseCache = new Map<string, Promise<any>>();

async function openArray(storeUrl: string, name: string) {
  const key = `${storeUrl}::${name}`;
  const cached = arrayPromiseCache.get(key);
  if (cached) return cached;
  const p = zarr.open(new zarr.FetchStore(`${storeUrl}/${name}`), { kind: "array" } as any);
  arrayPromiseCache.set(key, p);
  return p;
}

export async function loadGsZarrMeta(): Promise<GsZarrMeta> {
  // zarrita's FetchStore requires an absolute URL for `new URL(root)`.
  const storeUrl = normalizeBaseUrl(toAbsoluteUrl(configuredStoreUrl()));

  // Read consolidated metadata for labels/units when available.
  let zmeta: ZMetadata | null = null;
  try {
    zmeta = await fetchJson<ZMetadata>(`${storeUrl}/.zmetadata`);
  } catch {
    zmeta = null;
  }

  const bathy = await loadBathyLonLat();

  const timeUnits = String(zmeta?.metadata?.["time/.zattrs"]?.units ?? "seconds since 1970-01-01");

  // Coordinates (best-effort). If the coordinate arrays use an unsupported codec, we fall back to indices.
  const timeArr = await openArray(storeUrl, "time");
  const timeFull = await zarr.get(timeArr);
  // time is often int64 -> may arrive as BigInt64Array
  const timeNum = Array.from(timeFull.data as any, (v: any) => Number(v));
  const timeIso = toIsoDates(timeNum, timeUnits);

  const zVals = await (async () => {
    try {
      const zArr = await openArray(storeUrl, "Z");
      const zFull = await zarr.get(zArr);
      return ensureNegativeDown(Array.from(zFull.data as any, (v: any) => Number(v)));
    } catch {
      // Fallback: derive approximate cell-center depths from drF (thickness).
      try {
        const drfArr = await openArray(storeUrl, "drF");
        const drfFull = await zarr.get(drfArr);
        const drf = Array.from(drfFull.data as any, (v: any) => Number(v));
        let cum = 0;
        const z = drf.map((dz) => {
          const c = -(cum + dz / 2);
          cum += dz;
          return c;
        });
        return ensureNegativeDown(z);
      } catch {
        return Array.from({ length: 1 }, () => 0);
      }
    }
  })();

  const variables: GsZarrVariable[] = await Promise.all(
    (["T", "S"] as const).map(async (id) => {
      const attrs = zmeta?.metadata?.[`${id}/.zattrs`];
      const label = id === "T" ? "Temperature (T)" : "Salinity (S)";
      const units = typeof attrs?.units === "string" ? attrs.units : undefined;
      try {
        // Probe by attempting to open (will 404 if missing).
        await openArray(storeUrl, id);
        return { id, label, units, available: true };
      } catch {
        return { id, label, units, available: false };
      }
    })
  );

  return {
    storeUrl,
    lon: bathy.lon,
    lat: bathy.lat,
    z: zVals,
    timeIso,
    variables,
  };
}

export function nearestIndex(values: number[], target: number) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < values.length; i++) {
    const d = Math.abs(values[i] - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export async function loadHorizontalSlice(opts: {
  storeUrl: string;
  varId: "T" | "S";
  tIndex: number;
  zIndex: number;
  nLat: number;
  nLon: number;
}): Promise<number[][]> {
  const arr = await openArray(opts.storeUrl, opts.varId);
  const out = await zarr.get(arr, [opts.tIndex, opts.zIndex, null, null] as any);
  const shape = out.shape;
  if (shape.length !== 2) {
    throw new Error(`Expected 2D slice, got shape [${shape.join(",")}]`);
  }
  return reshape2D(out.data as any, shape[0], shape[1]);
}

export async function loadTransectSlice(opts: {
  storeUrl: string;
  varId: "T" | "S";
  tIndex: number;
  yIndex: number; // index into YC
}): Promise<{ values: number[][] }> {
  const arr = await openArray(opts.storeUrl, opts.varId);
  const out = await zarr.get(arr, [opts.tIndex, null, opts.yIndex, null] as any);
  const shape = out.shape;
  if (shape.length !== 2) {
    throw new Error(`Expected 2D transect, got shape [${shape.join(",")}]`);
  }
  return { values: reshape2D(out.data as any, shape[0], shape[1]) };
}
